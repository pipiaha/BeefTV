import { describe, expect, test } from "bun:test";

import { channelAllowsEmptyAPIKey } from "../src/lib/model-service-presets";
import { modelProtocolCapability } from "../src/lib/model-protocols";
import { nativeComfyCapabilityConfig, parseNativeComfyApiGraph, validateNativeComfyWorkflow } from "../src/lib/native-comfyui";
import { backendProviderConfig } from "../src/services/api/generation-task";
import {
    channelHasGenerationCredential,
    createModelChannel,
    defaultConfig,
    defaultBaseUrlForChannelInterface,
    encodeChannelModel,
    filterModelsByCapability,
    normalizeConfigSnapshot,
    resolveModelRequestConfig,
    type ModelChannel,
    type WorkflowFieldMapping,
} from "../src/stores/use-config-store";

const apiGraph = {
    prompt: {
        class_type: "CLIPTextEncode",
        inputs: { text: "default prompt", clip: ["model", 0] },
    },
    inputImage: {
        class_type: "LoadImage",
        inputs: { image: "placeholder.png", upload: "image" },
    },
    save: {
        class_type: "SaveImage",
        inputs: { filename_prefix: "beef", images: ["preview", 0] },
    },
};

function fields(): WorkflowFieldMapping[] {
    return [
        { id: "prompt::text", nodeId: "prompt", classType: "CLIPTextEncode", fieldName: "text", fieldValue: "default prompt", fieldType: "TEXT", source: "prompt", enabled: true },
        { id: "inputImage::image", nodeId: "inputImage", classType: "LoadImage", fieldName: "image", fieldValue: "placeholder.png", fieldType: "IMAGE", source: "referenceImage", imageOrder: 1, sourceIndex: 0, enabled: true },
        { id: "save::filename_prefix", nodeId: "save", classType: "SaveImage", fieldName: "filename_prefix", fieldValue: "beef", fieldType: "TEXT", enabled: false },
    ];
}

function nativeChannel(): ModelChannel {
    return createModelChannel({
        id: "comfy",
        name: "ComfyUI",
        baseUrl: "http://comfy.internal:8188/",
        apiKey: "",
        models: ["图工作流", "视频工作流", "音频工作流"],
        modelProfiles: [
            { model: "图工作流", displayName: "图工作流", capability: "image", protocol: "comfyui-image", authType: "none", comfyui: { graph: apiGraph, fields: fields(), outputNodeId: "save", outputField: "images" } },
            { model: "视频工作流", displayName: "视频工作流", capability: "video", protocol: "comfyui-video", authType: "none", comfyui: { graph: apiGraph, fields: fields(), outputNodeId: "save", outputField: "videos" } },
            { model: "音频工作流", displayName: "音频工作流", capability: "audio", protocol: "comfyui-audio", authType: "none", comfyui: { graph: apiGraph, fields: fields(), outputNodeId: "save", outputField: "audio" } },
        ],
    });
}

describe("native ComfyUI profiles", () => {
    test("accepts only API-format graphs and requires an explicit output", () => {
        expect(() => parseNativeComfyApiGraph({ nodes: [], links: [], version: "1" })).toThrow("浏览器界面导出的工作流");
        expect(() => parseNativeComfyApiGraph({ broken: { class_type: "SaveImage" } })).toThrow("缺少 inputs");

        const parsed = parseNativeComfyApiGraph(apiGraph);
        expect(Object.keys(parsed.graph)).toEqual(["prompt", "inputImage", "save"]);
        expect(validateNativeComfyWorkflow({ ...parsed, outputField: "images" })).toBe("请选择 ComfyUI 输出节点");
        expect(validateNativeComfyWorkflow({ ...parsed, outputNodeId: "missing", outputField: "images" })).toBe("ComfyUI 输出节点不存在");
        expect(validateNativeComfyWorkflow({ ...parsed, outputNodeId: "save", outputField: "images" })).toBe("");
    });

    test("save, normalize, serialize and reload preserve graph and typed mappings", () => {
        const original = nativeChannel();
        original.modelProfiles![0].comfyui!.releaseModelsAfter = true;
        const saved = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [original] } }).config;
        const serialized = JSON.parse(JSON.stringify({ config: saved }));
        const reloaded = normalizeConfigSnapshot(serialized).config;
        const channel = reloaded.channels.find((item) => item.id === "comfy")!;
        const image = channel.modelProfiles?.find((item) => item.model === "图工作流")?.comfyui;

        expect(image?.graph).toEqual(apiGraph);
        expect(image?.releaseModelsAfter).toBe(true);
        expect(image?.fields.map((field) => [field.nodeId, field.fieldName, field.source, field.enabled])).toEqual([
            ["prompt", "text", "prompt", true],
            ["inputImage", "image", "referenceImage", true],
            ["save", "filename_prefix", "", false],
        ]);
        expect(image?.fields.find((field) => field.fieldName === "image")?.imageOrder).toBe(1);
    });

    test("an incomplete stored output remains editable instead of breaking workspace startup", () => {
        const channel = nativeChannel();
        const raw = JSON.parse(JSON.stringify(channel));
        delete raw.modelProfiles[0].comfyui.outputNodeId;
        delete raw.modelProfiles[0].comfyui.outputField;
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [raw] } }).config;
        const workflow = config.channels[0].modelProfiles?.[0].comfyui;
        expect(workflow?.graph).toEqual(apiGraph);
        expect(validateNativeComfyWorkflow(workflow)).toBe("请选择 ComfyUI 输出节点");
    });

    test("resolved request and backend task config retain auth none, channel URL and workflow", () => {
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [nativeChannel()] } }).config;
        const model = encodeChannelModel("comfy", "图工作流");
        const request = resolveModelRequestConfig(config, model);
        const providerConfig = backendProviderConfig({ ...config, model }, "image") as Record<string, unknown>;

        expect(request.baseUrl).toBe("http://comfy.internal:8188/");
        expect(request.interfaceType).toBe("comfyui-image");
        expect(request.authType).toBe("none");
        expect(request.comfyui?.graph).toEqual(apiGraph);
        expect(providerConfig.interfaceType).toBe("comfyui-image");
        expect(providerConfig.authType).toBe("none");
        expect(providerConfig.comfyui).toEqual({ graph: apiGraph, fields: request.comfyui?.fields, outputNodeId: "save", outputField: "images" });
    });

    test("built-in protocol capabilities and auth-none rules select native entries without a key", () => {
        const channel = nativeChannel();
        const options = channel.models.map((model) => encodeChannelModel(channel.id, model));

        expect(modelProtocolCapability("comfyui-image")).toBe("image");
        expect(modelProtocolCapability("comfyui-video")).toBe("video");
        expect(modelProtocolCapability("comfyui-audio")).toBe("audio");
        expect(defaultBaseUrlForChannelInterface("comfyui-image")).toBe("");
        expect(defaultBaseUrlForChannelInterface("comfyui-video")).toBe("");
        expect(defaultBaseUrlForChannelInterface("comfyui-audio")).toBe("");
        expect(channelHasGenerationCredential(channel, "comfy::图工作流")).toBe(true);
        expect(channelHasGenerationCredential(channel)).toBe(true);
        expect(channelAllowsEmptyAPIKey(channel)).toBe(true);
        expect(filterModelsByCapability(options, "image", [channel])).toEqual([options[0]]);
        expect(filterModelsByCapability(options, "video", [channel])).toEqual([options[1]]);
        expect(filterModelsByCapability(options, "audio", [channel])).toEqual([options[2]]);

        const capability = nativeComfyCapabilityConfig("comfyui-video", { graph: apiGraph, fields: fields(), outputNodeId: "save", outputField: "videos" });
        expect(capability?.video?.references.maxImages).toBe(1);
        expect(capability?.video?.references.maxVideos).toBe(0);
        expect(capability?.video?.references.maxAudios).toBe(0);
        expect(capability?.video?.references.maxVideoDurationSeconds).toBe(0);
    });
});
