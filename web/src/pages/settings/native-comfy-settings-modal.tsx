import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Collapse, Form, Input, Popconfirm, Segmented, Select, Upload } from "antd";
import { Plus, Trash2 } from "lucide-react";

import { ModelEditorModal } from "@/components/model-editor-modal";
import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
import {
    NATIVE_COMFY_OUTPUT_FIELDS,
    nativeComfyCapabilityConfig,
    nativeComfyNodeOptions,
    nativeComfyProtocolForCapability,
    parseNativeComfyApiGraph,
    validateNativeComfyWorkflow,
    type NativeComfyCapability,
    type NativeComfyGraph,
} from "@/lib/native-comfyui";
import { normalizeWorkflowFieldMappings, createModelChannel, type ModelChannel, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { inspectNativeComfyUI } from "@/services/api/native-comfyui";

type ModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

type NativeComfySettingsModalProps = {
    open: boolean;
    initial: ModelChannel | null;
    onClose: () => void;
    onSave: (channel: ModelChannel) => Promise<void>;
};

const CAPABILITY_LABELS: Record<NativeComfyCapability, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
};

function isNativeProfile(profile: ModelProfile) {
    return Boolean(profile.comfyui) || profile.protocol === "comfyui-image" || profile.protocol === "comfyui-video" || profile.protocol === "comfyui-audio";
}

function blankProfile(capability: NativeComfyCapability = "image"): ModelProfile {
    return {
        model: "",
        displayName: "",
        capability,
        protocol: nativeComfyProtocolForCapability(capability),
        authType: "none",
        comfyui: { graph: {}, fields: [], outputNodeId: "", outputField: "", releaseModelsAfter: true },
    };
}

function draftProfiles(channel: ModelChannel) {
    const profiles = channel.modelProfiles?.filter(isNativeProfile) || [];
    return profiles.length ? profiles.map((profile) => ({ ...profile, comfyui: profile.comfyui || blankProfile(profile.capability as NativeComfyCapability).comfyui! })) : [blankProfile()];
}

function uniqueModelId(displayName: string, used: Set<string>) {
    const base = (displayName.trim() || "workflow").replace(/::/g, "-");
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    for (let index = 2; ; index += 1) {
        const candidate = `${base}-${index}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}

function createNativeComfyDraftChannel() {
    return createModelChannel({ name: "ComfyUI", interfaceType: nativeComfyProtocolForCapability("image"), baseUrl: "" });
}

export function NativeComfySettingsModal({ open, initial, onClose, onSave }: NativeComfySettingsModalProps) {
    const { message } = App.useApp();
    const [channel, setChannel] = useState<ModelChannel>(() => initial || createNativeComfyDraftChannel());
    const [profiles, setProfiles] = useState<ModelProfile[]>(() => draftProfiles(initial || createNativeComfyDraftChannel()));
    const [selectedModel, setSelectedModel] = useState("");
    const [graphText, setGraphText] = useState("");
    const [saving, setSaving] = useState(false);
    const [checking, setChecking] = useState(false);
    const [connection, setConnection] = useState<{ ok: boolean; message: string } | null>(null);
    const inspection = useRef<AbortController | null>(null);

    useEffect(() => {
        inspection.current?.abort();
        setConnection(null);
        setChecking(false);
        return () => inspection.current?.abort();
    }, [channel.baseUrl]);

    useEffect(() => {
        if (!open) return;
        const next = initial || createNativeComfyDraftChannel();
        const nextProfiles = draftProfiles(next);
        setChannel(next);
        setProfiles(nextProfiles);
        setSelectedModel(nextProfiles[0]?.model || "");
    }, [initial, open]);

    const selected = useMemo(() => profiles.find((profile) => profile.model === selectedModel) || profiles[0], [profiles, selectedModel]);
    const selectedCapability = (selected?.capability || "image") as NativeComfyCapability;

    useEffect(() => {
        setGraphText(selected?.comfyui?.graph && Object.keys(selected.comfyui.graph).length ? JSON.stringify(selected.comfyui.graph, null, 2) : "");
    }, [selected?.model, selected?.comfyui?.graph]);

    if (!open || !selected) return null;

    const updateChannel = (patch: Partial<ModelChannel>) => setChannel((current) => ({ ...current, ...patch }));
    const updateSelected = (patch: Partial<ModelProfile>) => setProfiles((current) => current.map((profile) => (profile.model === selected.model ? { ...profile, ...patch } : profile)));

    const updateWorkflow = (patch: Partial<NonNullable<ModelProfile["comfyui"]>>) => updateSelected({ comfyui: { ...selected.comfyui!, ...patch } });

    const updateCapability = (capability: NativeComfyCapability) => {
        updateSelected({ capability, protocol: nativeComfyProtocolForCapability(capability) });
    };

    const applyGraph = (raw: string) => {
        try {
            const parsedGraph = JSON.parse(raw) as unknown;
            const parsed = parseNativeComfyApiGraph(parsedGraph);
            if (selected.comfyui?.graph && JSON.stringify(parsed.graph) === JSON.stringify(selected.comfyui.graph)) {
                setGraphText(JSON.stringify(parsed.graph, null, 2));
                return;
            }
            updateWorkflow({
                graph: parsed.graph,
                fields: normalizeWorkflowFieldMappings(parsed.fields, selectedCapability),
                outputNodeId: "",
                outputField: "",
            });
            setGraphText(JSON.stringify(parsed.graph, null, 2));
            message.success(`已解析 ${Object.keys(parsed.graph).length} 个 ComfyUI 节点`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "ComfyUI API JSON 解析失败");
        }
    };

    const importFile = (file: File) => {
        void file
            .text()
            .then((text) => applyGraph(text))
            .catch(() => message.error("ComfyUI 工作流文件读取失败"));
        return false;
    };

    const addWorkflow = () => {
        const profile = blankProfile(selectedCapability);
        profile.model = `__draft-${profiles.length + 1}`;
        profile.displayName = "";
        setProfiles((current) => [...current, profile]);
        setSelectedModel(profile.model);
    };

    const removeWorkflow = () => {
        const remaining = profiles.filter((profile) => profile.model !== selected.model);
        const next = remaining.length ? remaining : [blankProfile()];
        setProfiles(next);
        setSelectedModel(next[0].model);
    };

    const save = async () => {
        if (channel.modelProfiles?.some((profile) => !isNativeProfile(profile))) {
            message.error("请将 ComfyUI 工作流保存到独立渠道，避免覆盖同一渠道中的其他模型配置");
            return;
        }
        const name = channel.name.trim();
        const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
        if (!name) return void message.error("请填写渠道名称");
        try {
            const url = new URL(baseUrl);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("地址无效");
        } catch {
            return void message.error("请填写不含路径、账号或查询参数的 HTTP(S) 服务地址");
        }

        const prepared: ModelProfile[] = [];
        const usedIds = new Set<string>();
        for (const profile of profiles) {
            const displayName = profile.displayName?.trim() || "";
            if (!displayName) return void message.error("请填写工作流名称");
            const workflowError = validateNativeComfyWorkflow(profile.comfyui);
            if (workflowError) return void message.error(`${displayName}：${workflowError}`);
            const capability = profile.capability as NativeComfyCapability;
            const protocol = nativeComfyProtocolForCapability(capability);
            const workflow = {
                ...profile.comfyui!,
                graph: profile.comfyui!.graph,
                fields: normalizeWorkflowFieldMappings(profile.comfyui!.fields, capability),
                outputNodeId: profile.comfyui!.outputNodeId.trim(),
                outputField: profile.comfyui!.outputField,
            };
            const savedModelId = profile.model;
            let model: string;
            if (savedModelId && !savedModelId.startsWith("__draft-") && !usedIds.has(savedModelId)) {
                usedIds.add(savedModelId);
                model = savedModelId;
            } else {
                model = uniqueModelId(displayName, usedIds);
            }
            prepared.push({
                ...profile,
                model,
                displayName,
                capability,
                protocol,
                authType: "none",
                comfyui: workflow,
                capabilityConfig: nativeComfyCapabilityConfig(protocol, workflow),
            });
        }

        const otherProfiles = channel.modelProfiles?.filter((profile) => !isNativeProfile(profile)) || [];
        const models = prepared.map((profile) => profile.model);
        setSaving(true);
        try {
            await onSave({
                ...channel,
                name,
                baseUrl,
                apiKey: "",
                secretKey: "",
                credentialRef: undefined,
                hasApiKey: undefined,
                hasSecretKey: undefined,
                headers: [],
                interfaceType: undefined,
                models,
                modelProfiles: [...prepared, ...otherProfiles],
            });
        } finally {
            setSaving(false);
        }
    };

    const nodeOptions = nativeComfyNodeOptions(selected.comfyui?.graph as NativeComfyGraph | undefined);
    const checkConnection = async () => {
        inspection.current?.abort();
        const controller = new AbortController();
        inspection.current = controller;
        setChecking(true);
        setConnection(null);
        try {
            const result = await inspectNativeComfyUI(channel.baseUrl.trim().replace(/\/+$/, ""), controller.signal);
            if (!controller.signal.aborted) setConnection({ ok: true, message: `已连接 ComfyUI ${result.stats.system?.comfyui_version || ""} · ${Object.keys(result.nodes).length} 个节点` });
        } catch (error) {
            if (!controller.signal.aborted) setConnection({ ok: false, message: error instanceof Error ? error.message : "读取服务失败" });
        } finally {
            if (inspection.current === controller) setChecking(false);
        }
    };
    const workflowOptions = profiles.map((profile, index) => ({
        value: profile.model,
        label: profile.displayName?.trim() || `未命名工作流 ${index + 1}`,
    }));

    return (
        <ModelEditorModal
            title="原生 ComfyUI 工作流"
            subtitle="每个工作流作为一个模型条目；同一渠道共享 Base URL，鉴权为无。"
            open={open}
            onClose={onClose}
            busy={saving}
            footer={
                <>
                    <Button onClick={onClose} disabled={saving}>
                        取消
                    </Button>
                    <Button type="primary" loading={saving} onClick={() => void save()}>
                        保存渠道
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <Alert type={connection ? connection.ok ? "success" : "error" : "info"} showIcon message={connection?.message || "连接状态：尚未检查"} description="连接检查只读取服务版本和节点清单。实际生成结果以任务为准。" />
                <section className="model-editor-section">
                    <div>
                        <h2>服务连接</h2>
                        <p className="mt-1 text-xs text-foreground/50">ComfyUI 使用原生任务通道，不读取 OpenAI/Gemini 模型目录。</p>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                        <Form.Item label="渠道名称" className="mb-0">
                            <Input value={channel.name} onChange={(event) => updateChannel({ name: event.target.value })} />
                        </Form.Item>
                        <Form.Item label="Base URL" className="mb-0" extra="填写 ComfyUI 服务基础地址；本机和局域网可使用 HTTP。">
                            <Input
                                inputMode="url"
                                value={channel.baseUrl}
                                placeholder="填写 ComfyUI 服务地址"
                                onChange={(event) => updateChannel({ baseUrl: event.target.value })}
                                onBlur={() => updateChannel({ baseUrl: channel.baseUrl.trim().replace(/\/+$/, "") })}
                            />
                        </Form.Item>
                    </div>
                    <Button loading={checking} disabled={!channel.baseUrl.trim()} onClick={() => void checkConnection()}>检查连接</Button>
                    <div className="mt-3"><Checkbox checked={selected.comfyui?.releaseModelsAfter === true} onChange={(event) => updateWorkflow({ releaseModelsAfter: event.target.checked })}>当前工作流完成后释放空闲服务的模型缓存（多个实例共享显卡时建议开启）</Checkbox></div>
                </section>
                <section className="model-editor-section">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                        <div>
                            <h2>工作流模型</h2>
                            <p className="mt-1 text-xs text-foreground/50">工作流名称会出现在对应的图片、视频或音频模型选择器中。</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Select className="min-w-56" showSearch optionFilterProp="label" value={selected.model} options={workflowOptions} onChange={setSelectedModel} />
                            <Button icon={<Plus className="size-4" />} onClick={addWorkflow}>
                                新增
                            </Button>
                            <Popconfirm title="删除当前工作流？" okText="删除" cancelText="取消" onConfirm={removeWorkflow}>
                                <Button danger icon={<Trash2 className="size-4" />} />
                            </Popconfirm>
                        </div>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-3">
                        <Form.Item label="工作流名称" className="mb-0">
                            <Input value={selected.displayName || ""} onChange={(event) => updateSelected({ displayName: event.target.value })} />
                        </Form.Item>
                        <Form.Item label="生成模式" className="mb-0">
                            <Segmented<NativeComfyCapability>
                                block
                                value={selectedCapability}
                                options={(Object.keys(CAPABILITY_LABELS) as NativeComfyCapability[]).map((value) => ({ label: CAPABILITY_LABELS[value], value }))}
                                onChange={updateCapability}
                            />
                        </Form.Item>
                        <Form.Item label="输出节点" className="mb-0">
                            <Select showSearch optionFilterProp="label" value={selected.comfyui?.outputNodeId || undefined} options={nodeOptions} onChange={(outputNodeId) => updateWorkflow({ outputNodeId })} notFoundContent="导入 API JSON 后选择" />
                        </Form.Item>
                        <Form.Item label="输出字段" className="mb-0" extra="最终媒体类型由任务模式和返回文件 MIME 决定，不由字段名猜测。">
                            <Select value={selected.comfyui?.outputField || undefined} options={NATIVE_COMFY_OUTPUT_FIELDS.map((value) => ({ value, label: value }))} onChange={(outputField) => updateWorkflow({ outputField })} />
                        </Form.Item>
                    </div>
                    <Collapse
                        className="mt-3"
                        items={[
                            {
                                key: "json",
                                label: "导入或编辑 API JSON",
                                children: (
                                    <div className="space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Upload accept=".json,application/json" maxCount={1} showUploadList={false} beforeUpload={importFile}>
                                                <Button>选择 API JSON 文件</Button>
                                            </Upload>
                                            <span className="text-xs text-foreground/55">仅支持 ComfyUI 开发者模式导出的 API JSON；浏览器界面 JSON 会被明确拒绝。</span>
                                        </div>
                                        <Input.TextArea
                                            className="font-mono text-xs"
                                            rows={10}
                                            value={graphText}
                                            placeholder="粘贴 API 格式 JSON，移出输入框后解析"
                                            onChange={(event) => setGraphText(event.target.value)}
                                            onBlur={() => graphText.trim() && applyGraph(graphText)}
                                        />
                                    </div>
                                ),
                            },
                        ]}
                    />
                    <div className="mt-3">
                        <WorkflowGraphEditor
                            workflowJson={selected.comfyui?.graph as Record<string, unknown> | undefined}
                            fields={(selected.comfyui?.fields || []) as WorkflowFieldMapping[]}
                            onChange={(fields) => updateWorkflow({ fields })}
                            emptyDescription="请先导入 API 格式 ComfyUI 工作流"
                        />
                    </div>
                </section>
            </div>
        </ModelEditorModal>
    );
}
