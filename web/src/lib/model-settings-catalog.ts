import { isNativeComfyProtocol, nativeComfyCapabilityConfig, nativeComfyProtocolForCapability, validateNativeComfyWorkflow, type NativeComfyCapability, type NativeComfyWorkflow } from "@/lib/native-comfyui";
import { filterModelsByCapability, modelOptionName, modelOptionsFromChannels, type AudioModelUse, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

export type ModelUsage = "all" | ModelCapability | AudioModelUse | "other-audio";
export type NativeComfyProfile = NonNullable<ModelChannel["modelProfiles"]>[number];
export const AUDIO_USE_LABELS: Record<AudioModelUse, string> = { music: "音乐", speech: "配音", sound: "音效" };
export const MODEL_USAGE_LABELS: Record<ModelUsage, string> = { all: "全部", text: "文本", image: "图片", video: "视频", audio: "全部音频", ...AUDIO_USE_LABELS, "other-audio": "其他音频" };
export const MODEL_USAGE_ORDER: ModelUsage[] = ["all", "text", "image", "video", "music", "speech", "sound", "other-audio"];
export const NATIVE_USAGE_ORDER = ["image", "video", "music", "speech", "sound", "other-audio"] as const;

export function modelUsageCapability(usage: ModelUsage): ModelCapability | undefined {
    if (usage === "all") return undefined;
    return usage === "music" || usage === "speech" || usage === "sound" || usage === "other-audio" ? "audio" : usage;
}

export function audioUsesForProfile(profile: Pick<NativeComfyProfile, "capability" | "protocol" | "audioUses">): AudioModelUse[] {
    if (profile.capability !== "audio") return [];
    if (Array.isArray(profile.audioUses)) return [...new Set(profile.audioUses.filter((use) => Object.hasOwn(AUDIO_USE_LABELS, use)))];
    // This built-in protocol has the explicit /audio/speech contract.
    return profile.protocol === "openai-audio" ? ["speech"] : [];
}

export function profileMatchesUsage(profile: NativeComfyProfile, usage: ModelUsage) {
    if (usage === "all") return true;
    if (profile.capability !== modelUsageCapability(usage)) return false;
    if (usage === "other-audio") return audioUsesForProfile(profile).length === 0;
    if (Object.hasOwn(AUDIO_USE_LABELS, usage)) return audioUsesForProfile(profile).includes(usage as AudioModelUse);
    return true;
}

export function profileUsageLabel(profile: NativeComfyProfile) {
    if (profile.capability !== "audio") return MODEL_USAGE_LABELS[profile.capability];
    return (
        audioUsesForProfile(profile)
            .map((use) => AUDIO_USE_LABELS[use])
            .join(" · ") || "其他音频"
    );
}

export function withProfileUsage(profile: NativeComfyProfile, usage: ModelUsage): NativeComfyProfile {
    if (profile.capability !== "audio") return profile;
    if (Object.hasOwn(AUDIO_USE_LABELS, usage)) return { ...profile, audioUses: [usage as AudioModelUse] };
    if (usage === "other-audio") return { ...profile, audioUses: [] };
    return profile;
}

export function isNativeComfyChannel(channel: ModelChannel) {
    return channel.modelProfiles?.some((profile) => isNativeComfyProtocol(profile.protocol) || Boolean(profile.comfyui)) === true;
}

export function modelsForUsage(channel: ModelChannel, usage: ModelUsage) {
    if (usage === "all") return channel.models;
    const capability = modelUsageCapability(usage)!;
    return filterModelsByCapability(modelOptionsFromChannels([channel]), capability, [channel])
        .map(modelOptionName)
        .filter((model) => {
            const profile = channel.modelProfiles?.find((profile) => profile.model === model);
            return profile ? profileMatchesUsage(profile, usage) : usage === capability || usage === "other-audio";
        });
}

export function prepareNativeComfyChannel(channel: ModelChannel, profiles: NativeComfyProfile[]): ModelChannel {
    if (channel.modelProfiles?.some((profile) => !isNativeComfyProtocol(profile.protocol) && !profile.comfyui)) throw new Error("该服务还包含其他接入方式，请使用独立的 ComfyUI 服务，避免覆盖其他模型");
    if (!channel.name.trim()) throw new Error("请填写服务名称");
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new Error("请填写完整的 HTTP(S) 服务地址");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) throw new Error("服务地址只填写主机和端口，不包含路径、账号或查询参数");
    if (!profiles.length) throw new Error("请至少添加一个工作流");
    const savedIds = profiles.map((profile) => profile.model).filter((id) => id && !id.startsWith("__draft-"));
    if (new Set(savedIds).size !== savedIds.length) throw new Error("工作流标识重复，请检查后重新保存");
    const used = new Set(savedIds);
    const prepared = profiles.map((profile) => {
        const name = profile.displayName?.trim();
        if (!name) throw new Error("请为每个工作流填写名称");
        if (!["image", "video", "audio"].includes(profile.capability)) throw new Error(`${name}：请选择图片、视频或音频类型`);
        const error = validateNativeComfyWorkflow(profile.comfyui);
        if (error) throw new Error(`${name}：${error}`);
        let model = profile.model;
        if (!model || model.startsWith("__draft-")) {
            const base = name.replace(/::/g, "-");
            model = base;
            for (let index = 2; used.has(model); index++) model = `${base}-${index}`;
            used.add(model);
        }
        const protocol = nativeComfyProtocolForCapability(profile.capability as NativeComfyCapability);
        return { ...profile, model, displayName: name, protocol, authType: profile.authType || "none", capabilityConfig: nativeComfyCapabilityConfig(protocol, profile.comfyui!) };
    });
    // 服务的身份、凭据和其他连接选项不因编辑工作流被清空。
    return { ...channel, name: channel.name.trim(), baseUrl, interfaceType: undefined, models: prepared.map((profile) => profile.model), modelProfiles: prepared };
}

export function inferNativeComfyOutput(graph: Record<string, Record<string, unknown>>) {
    const candidates = Object.entries(graph).filter(([, node]) => /^(SaveImage|SaveVideo|SaveAudio\w*|VHS_VideoCombine|VideoCombine)$/.test(String(node.class_type)));
    if (candidates.length !== 1) return { outputNodeId: "", outputField: "" };
    const [outputNodeId, node] = candidates[0];
    const classType = String(node.class_type);
    return { outputNodeId, outputField: /Audio/.test(classType) ? "audio" : /VideoCombine/.test(classType) ? "gifs" : "images" };
}

export type ComfyInputControl = { nodeId: string; fieldName: string; label: string; value: string | number | boolean; choices?: string[]; min?: number; max?: number; step?: number; bound: boolean };
const BASIC_LABELS: Record<string, string> = {
    width: "宽度",
    height: "高度",
    steps: "采样步数",
    cfg: "提示词强度",
    seed: "随机种子",
    noise_seed: "随机种子",
    length: "帧数",
    num_frames: "帧数",
    frame_count: "帧数",
    frames: "帧数",
    fps: "帧率",
    frame_rate: "帧率",
    duration: "时长（秒）",
    duration_seconds: "时长（秒）",
    seconds: "时长（秒）",
    audio_duration: "音频时长（秒）",
    max_duration: "最长时长（秒）",
    min_duration: "最短时长（秒）",
    cfg_scale: "提示词强度",
    caption: "描述",
    speaker_id: "说话人",
    bpm: "节奏（BPM）",
    lyrics: "歌词",
    tags: "风格",
    text: "文本",
    prompt: "提示词",
    voice: "音色",
    speaker: "说话人",
    language: "语言",
    speed: "语速",
    pitch: "音调",
    volume: "音量",
    batch_size: "生成数量",
};
const MODEL_LABELS: Record<string, string> = {
    ckpt_name: "Checkpoint",
    unet_name: "扩散模型",
    vae_name: "VAE",
    lora_name: "LoRA",
    clip_name: "文本编码器",
    clip_name1: "文本编码器 1",
    clip_name2: "文本编码器 2",
    model_name: "主模型",
    diffusion_model: "扩散模型",
    text_encoder_name: "文本编码器",
    control_net_name: "控制模型",
};

export function nativeComfyInputControls(flow: NativeComfyWorkflow, nodes?: Record<string, unknown>) {
    const models: ComfyInputControl[] = [];
    const parameters: ComfyInputControl[] = [];
    for (const [nodeId, node] of Object.entries(flow.graph)) {
        const schema = nodes?.[String(node.class_type)] as { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined;
        for (const [fieldName, value] of Object.entries((node.inputs || {}) as Record<string, unknown>)) {
            if (!["string", "number", "boolean"].includes(typeof value)) continue;
            const field = flow.fields.find((field) => field.nodeId === nodeId && field.fieldName === fieldName);
            const label = MODEL_LABELS[fieldName] || BASIC_LABELS[fieldName] || (field?.safeToOverride !== false ? field?.label || fieldName : "");
            if (!label) continue;
            const spec = schema?.input?.required?.[fieldName] || schema?.input?.optional?.[fieldName];
            const tuple = Array.isArray(spec) ? spec : [];
            const meta = tuple[1] && typeof tuple[1] === "object" ? (tuple[1] as Record<string, unknown>) : {};
            const choices = Array.isArray(tuple[0]) ? tuple[0] : Array.isArray(meta.options) ? meta.options : undefined;
            const mapping = flow.fields.find((field) => field.nodeId === nodeId && field.fieldName === fieldName && field.enabled !== false);
            const bound = Boolean(mapping?.randomEnabled || mapping?.bindPrompt || (mapping?.source && !["static", "value", "constant"].includes(mapping.source)));
            const configured = mapping?.fieldValue ?? mapping?.value;
            const control: ComfyInputControl = {
                nodeId,
                fieldName,
                label,
                value: !bound && typeof configured === typeof value ? (configured as string | number | boolean) : (value as string | number | boolean),
                bound,
                min: typeof meta.min === "number" ? meta.min : undefined,
                max: typeof meta.max === "number" ? Math.min(meta.max, Number.MAX_SAFE_INTEGER) : undefined,
                step: typeof meta.step === "number" ? meta.step : fieldName === "cfg" ? 0.1 : 1,
            };
            if (MODEL_LABELS[fieldName]) models.push({ ...control, choices: choices?.filter((item): item is string => typeof item === "string") });
            else parameters.push({ ...control, choices: choices?.filter((item): item is string => typeof item === "string") });
        }
    }
    parameters.sort((left, right) => Number(Boolean(BASIC_LABELS[right.fieldName])) - Number(Boolean(BASIC_LABELS[left.fieldName])));
    return { models, parameters };
}

export function updateNativeComfyInput(flow: NativeComfyWorkflow, input: ComfyInputControl, value: string | number | boolean): NativeComfyWorkflow {
    if (input.bound) throw new Error("该字段由生成参数映射，请在高级设置中调整绑定");
    const node = flow.graph[input.nodeId];
    const inputs = node?.inputs as Record<string, unknown> | undefined;
    if (!inputs || typeof inputs[input.fieldName] !== typeof value) throw new Error("工作流字段类型不匹配");
    if (typeof value === "number" && (!Number.isFinite(value) || (input.min !== undefined && value < input.min) || (input.max !== undefined && value > input.max))) throw new Error("参数超出目标节点允许范围");
    if (input.choices?.length && !input.choices.includes(String(value))) throw new Error("请选择目标节点提供的选项");
    return {
        ...flow,
        graph: { ...flow.graph, [input.nodeId]: { ...node, inputs: { ...inputs, [input.fieldName]: value } } },
        fields: flow.fields.map((field) => (field.nodeId === input.nodeId && field.fieldName === input.fieldName ? { ...field, fieldValue: value } : field)),
    };
}
