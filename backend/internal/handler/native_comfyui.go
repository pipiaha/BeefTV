package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/outbound"

	"github.com/gin-gonic/gin"
)

type nativeComfyInspectRequest struct {
	BaseURL    string                    `json:"baseUrl"`
	AuthType   string                    `json:"authType,omitempty"`
	APIKey     string                    `json:"apiKey,omitempty"`
	AuthHeader string                    `json:"authHeader,omitempty"`
	Headers    []outbound.OutboundHeader `json:"headers,omitempty"`
}

func RegisterNativeComfyUIRoutes(api *gin.RouterGroup, svc *app.Service) {
	api.POST("/configured-providers/comfyui/inspect", func(c *gin.Context) {
		_, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var request nativeComfyInspectRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		headers := make([]outbound.OutboundHeader, len(request.Headers))
		for i, item := range request.Headers {
			headers[i] = outbound.OutboundHeader{Name: item.Name, Value: item.Value}
		}
		result, err := svc.InspectNativeComfyUI(c.Request.Context(), app.NativeComfyInspectConfig{
			BaseURL: request.BaseURL, AuthType: request.AuthType, APIKey: request.APIKey,
			AuthHeader: request.AuthHeader, Headers: headers,
		})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
}
