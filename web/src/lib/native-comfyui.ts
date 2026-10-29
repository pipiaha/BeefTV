import { defaultModelCapabilityConfig, workflowImageCapabilityConfig, workflowVideoCapabilityConfig, workflowVideoFieldsFromJson, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelProtocol } from "@/lib/model-protocols";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

export type NativeComfyCapability = "image" | "video" | "audio";
export type NativeComfyGraph = Record<string, Record<string, unknown>>;
export type NativeComfyWorkflow = {
    releaseModelsAfter?: boolean;
    graph: NativeComfyGraph;
    fields: WorkflowFieldMapping[];
    outputNodeId: string;
    outputField: string;
};

export const NATIVE_COMFY_OUTPUT_FIELDS = ["images", "gifs", "videos", "audio"] as const;
export const NATIVE_COMFY_PROTOCOLS: Record<NativeComfyCapability, ModelProtocol> = {
    image: "comfyui-image",
    video: "comfyui-video",
    audio: "comfyui-audio",
};

export function isNativeComfyProtocol(protocol: string | undefined): protocol is ModelProtocol {
    return protocol === NATIVE_COMFY_PROTOCOLS.image || protocol === NATIVE_COMFY_PROTOCOLS.video || protocol === NATIVE_COMFY_PROTOCOLS.audio;
}

export function nativeComfyProtocolForCapability(capability: NativeComfyCapability) {
    return NATIVE_COMFY_PROTOCOLS[capability];
}

export function nativeComfyCapabilityForProtocol(protocol: string | undefined): NativeComfyCapability | undefined {
    if (!isNativeComfyProtocol(protocol)) return undefined;
    return (["image", "video", "audio"] as const).find((capability) => NATIVE_COMFY_PROTOCOLS[capability] === protocol);
}

type ParsedNativeComfyGraph = {
    graph: NativeComfyGraph;
    fields: WorkflowFieldMapping[];
};

export function parseNativeComfyApiGraph(value: unknown): ParsedNativeComfyGraph {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ComfyUI 工作流 JSON 必须是对象");
    const candidate = value as Record<string, unknown>;
    if (Array.isArray(candidate.nodes) || Array.isArray(candidate.links) || Array.isArray(candidate.groups)) {
        throw new Error("这是 ComfyUI 浏览器界面导出的工作流。请在 ComfyUI 开启开发者模式后导出 API JSON，再重新导入");
    }
    if (!Object.keys(candidate).length) throw new Error("ComfyUI API JSON 不能为空");
    if (Object.keys(candidate).length > 500) throw new Error("ComfyUI 工作流最多支持 500 个节点");

    const graph: NativeComfyGraph = {};
    for (const [nodeId, rawNode] of Object.entries(candidate)) {
        if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) throw new Error(`ComfyUI 节点 ${nodeId} 不是 API 格式对象`);
        const node = rawNode as Record<string, unknown>;
        const classType = node.class_type;
        const inputs = node.inputs;
        if (typeof classType !== "string" || !classType.trim()) throw new Error(`ComfyUI 节点 ${nodeId} 缺少 class_type`);
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error(`ComfyUI 节点 ${nodeId} 缺少 inputs`);
        graph[nodeId] = node;
    }

    return {
        graph,
        fields: workflowVideoFieldsFromJson(graph).map((field) => ({
            ...field,
            nodeId: String(field.nodeId || ""),
            fieldName: String(field.fieldName || ""),
        })) as WorkflowFieldMapping[],
    };
}

export function validateNativeComfyWorkflow(workflow: Partial<NativeComfyWorkflow> | undefined) {
    if (!workflow?.graph || !Object.keys(workflow.graph).length) return "请导入 API 格式 ComfyUI 工作流";
    if (!workflow.outputNodeId?.trim()) return "请选择 ComfyUI 输出节点";
    if (!workflow.graph[workflow.outputNodeId]) return "ComfyUI 输出节点不存在";
    if (!NATIVE_COMFY_OUTPUT_FIELDS.includes(workflow.outputField as (typeof NATIVE_COMFY_OUTPUT_FIELDS)[number])) return "请选择 ComfyUI 输出字段";
    for (const field of workflow.fields || []) {
        if (field.enabled === false) continue;
        const node = workflow.graph[field.nodeId];
        if (!node) return `字段映射的节点 ${field.nodeId} 不存在`;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs) || typeof (inputs as Record<string, unknown>)[field.fieldName] === "undefined") {
            return `字段映射的输入 ${field.nodeId}.${field.fieldName} 不存在`;
        }
        if (Array.isArray((inputs as Record<string, unknown>)[field.fieldName])) return `字段映射的输入 ${field.nodeId}.${field.fieldName} 是连线，不能覆盖`;
    }
    return "";
}

export function nativeComfyCapabilityConfig(protocol: ModelProtocol, workflow: NativeComfyWorkflow): ModelCapabilityConfig | undefined {
    const capability = nativeComfyCapabilityForProtocol(protocol);
    if (!capability) return undefined;
    const fallback = defaultModelCapabilityConfig(protocol);
    const fields = (workflow.fields || []).filter((field) => field.enabled !== false);
    const slotCount = (source: WorkflowFieldMapping["source"]) => fields.filter((field) => field.source === source).length;
    if (capability === "image") {
        const image = workflowImageCapabilityConfig(fields, fallback.image);
        image.references.maxImages = slotCount("referenceImage");
        image.references.maxImageBytes = 128 * 1024 * 1024;
        image.references.maskSupported = slotCount("mask") > 0;
        return { ...fallback, image };
    }
    if (capability === "video") {
        const video = workflowVideoCapabilityConfig(fields, fallback.video);
        video.references.maxImages = slotCount("referenceImage");
        video.references.maxImageBytes = 128 * 1024 * 1024;
        video.references.maxVideos = slotCount("referenceVideo");
        video.references.maxVideoBytes = 128 * 1024 * 1024;
        video.references.maxVideoDurationSeconds = 0;
        video.references.maxAudios = slotCount("referenceAudio");
        video.references.maxAudioBytes = 128 * 1024 * 1024;
        video.references.maxAudioDurationSeconds = 0;
        video.operations = Array.from(new Set(["text_to_video", "image_to_video", "reference_to_video", "audio_to_video"]));
        return { ...fallback, video };
    }
    return fallback;
}

export function nativeComfyNodeOptions(graph: NativeComfyGraph | undefined) {
    return Object.entries(graph || {}).map(([value, node]) => {
        const classType = String(node.class_type || "");
        return { value, label: classType ? `${classType} · #${value}` : `#${value}` };
    });
}
