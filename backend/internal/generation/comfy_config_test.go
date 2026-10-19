package generation

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestComfyConfigSerializationAndCamelCaseAlias(t *testing.T) {
	graph := map[string]any{"1": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"2", 0}}}}
	config := Config{
		InterfaceType: "comfyui-image", BaseURL: "http://127.0.0.1:18188", AuthType: "none",
		ComfyUI: &ComfyWorkflow{Graph: graph, OutputNodeID: "1", OutputField: "images"},
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"comfyui":`) {
		t.Fatalf("missing comfyui field: %s", encoded)
	}
	var decoded Config
	if err := json.Unmarshal([]byte(`{"interfaceType":"comfyui-audio","baseUrl":"http://127.0.0.1:18188","authType":"none","comfyUI":{"graph":{"1":{"class_type":"SaveAudio","inputs":{"audio":["2",0]}}},"outputNodeId":"1","outputField":"audio"}}`), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ComfyUI == nil || decoded.ComfyUI.Graph["1"] == nil || decoded.ComfyUI.OutputField != "audio" {
		t.Fatalf("decoded config = %#v", decoded)
	}
}
