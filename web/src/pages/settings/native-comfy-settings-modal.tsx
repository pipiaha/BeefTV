import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Dropdown, Form, Input, InputNumber, Popconfirm, Select, Switch } from "antd";
import { Braces, Check, ChevronDown, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { NativeComfyMappings } from "./native-comfy-mappings";
import { NATIVE_COMFY_OUTPUT_FIELDS, nativeComfyNodeOptions, nativeComfyProtocolForCapability, parseNativeComfyApiGraph, validateNativeComfyWorkflow, type NativeComfyCapability } from "@/lib/native-comfyui";
import {
    AUDIO_USE_LABELS,
    audioUsesForProfile,
    MODEL_USAGE_LABELS,
    NATIVE_USAGE_ORDER,
    modelUsageCapability,
    profileMatchesUsage,
    profileUsageLabel,
    withProfileUsage,
    inferNativeComfyOutput,
    nativeComfyInputControls,
    prepareNativeComfyChannel,
    updateNativeComfyInput,
    type ModelUsage,
    type NativeComfyProfile,
    type ComfyInputControl,
} from "@/lib/model-settings-catalog";
import { createModelChannel, type ModelChannel, type AudioModelUse } from "@/stores/use-config-store";
import { inspectNativeComfyUI, type NativeComfyInspection } from "@/services/api/native-comfyui";
import "./native-comfy-settings.css";

const LABELS: Record<NativeComfyCapability, string> = { image: "图片", video: "视频", audio: "音频" };
function blankProfile(capability: NativeComfyCapability, usage: ModelUsage = capability): NativeComfyProfile {
    return withProfileUsage(
        {
            model: "__draft-" + crypto.randomUUID(),
            displayName: "",
            capability,
            protocol: nativeComfyProtocolForCapability(capability),
            authType: "none",
            comfyui: { graph: {}, fields: [], outputNodeId: "", outputField: "", releaseModelsAfter: false },
        },
        usage,
    );
}
function draft(initial: ModelChannel | null, capability: NativeComfyCapability, usage: ModelUsage) {
    const connection = initial ? structuredClone(initial) : createModelChannel({ name: "", baseUrl: "", interfaceType: nativeComfyProtocolForCapability(capability) });
    const profiles = connection.modelProfiles?.filter((profile) => profile.comfyui || profile.protocol?.startsWith("comfyui-")) || [];
    return { connection, profiles: profiles.length ? profiles : [blankProfile(capability, usage)] };
}
export function NativeComfySettingsModal({
    open = true,
    initial,
    initialCapability = "image",
    initialUsage = initialCapability,
    onClose,
    onSave,
    onDraftChange,
    onBusyChange,
    onJSONEditingChange,
    initialModel,
}: {
    open?: boolean;
    initial: ModelChannel | null;
    initialCapability?: NativeComfyCapability;
    initialUsage?: ModelUsage;
    onClose: () => void;
    onSave: (channel: ModelChannel) => Promise<void>;
    onDraftChange: (channel: ModelChannel) => void;
    onBusyChange: (busy: boolean) => void;
    onJSONEditingChange: (editing: boolean) => void;
    initialModel?: string;
}) {
    const [channel, setChannel] = useState(() => draft(initial, initialCapability, initialUsage).connection);
    const [profiles, setProfiles] = useState(() => draft(initial, initialCapability, initialUsage).profiles);
    const [panel, setPanel] = useState("connection");
    const [jsonMode, setJSONMode] = useState<"paste" | "edit" | null>(null);
    const [jsonText, setJSONText] = useState("");
    const [jsonError, setJSONError] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [checking, setChecking] = useState(false);
    const [inspection, setInspection] = useState<NativeComfyInspection | null>(null);
    const [connectionError, setConnectionError] = useState("");
    const request = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const body = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const next = draft(initial, initialCapability, initialUsage);
        setChannel(next.connection);
        setProfiles(next.profiles);
        setPanel(initialModel || (next.profiles.find((profile) => profileMatchesUsage(profile, initialUsage)) || next.profiles[0]).model);
        setJSONMode(null);
        setError("");
        setJSONError("");
    }, [initial, initialCapability, initialUsage, initialModel, open]);
    useEffect(() => {
        request.current?.abort();
        setInspection(null);
        setChecking(false);
        setConnectionError("");
        return () => request.current?.abort();
    }, [channel.baseUrl]);
    useEffect(() => {
        onDraftChange({ ...channel, modelProfiles: profiles });
    }, [channel, profiles, onDraftChange]);
    useEffect(() => {
        onBusyChange(saving);
    }, [saving, onBusyChange]);
    useEffect(() => {
        onJSONEditingChange(Boolean(jsonMode));
        return () => onJSONEditingChange(false);
    }, [jsonMode, onJSONEditingChange]);
    const selected = profiles.find((profile) => profile.model === panel);
    const flow = selected?.comfyui;
    const controls = useMemo(() => {
        const inputs = flow ? nativeComfyInputControls(flow, inspection?.nodes) : { models: [], parameters: [] };
        return { ...inputs, parameters: inputs.parameters.filter((input) => !(input.bound && typeof input.value === "string")) };
    }, [flow, inspection]);
    const setProfile = (patch: Partial<NativeComfyProfile>) => {
        if (!selected) return;
        setProfiles((current) => current.map((profile) => (profile.model === selected.model ? { ...profile, ...patch } : profile)));
        setError("");
    };
    const setFlow = (patch: Partial<NonNullable<NativeComfyProfile["comfyui"]>>) => setProfile({ comfyui: { ...flow!, ...patch } });
    const selectPanel = (key: string) => {
        if (jsonMode) {
            setJSONError("请先检查并应用 JSON，或取消编辑，再切换工作流");
            return;
        }
        setPanel(key);
        setError("");
        setJSONError("");
        body.current?.scrollTo({ top: 0 });
    };
    const addWorkflow = (usage: ModelUsage) => {
        if (jsonMode) {
            setJSONError("请先应用或取消当前 JSON 编辑");
            return;
        }
        const profile = blankProfile(modelUsageCapability(usage) as NativeComfyCapability, usage);
        setProfiles((current) => [...current, profile]);
        setPanel(profile.model);
        setError("");
    };
    const removeWorkflow = () => {
        const next = profiles.filter((profile) => profile.model !== panel);
        setProfiles(next);
        setPanel(next[0]?.model || "connection");
        setJSONMode(null);
    };
    const checkConnection = async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setChecking(true);
        setConnectionError("");
        try {
            const result = await inspectNativeComfyUI(channel.baseUrl.trim().replace(/\/+$/, ""), controller.signal);
            if (!controller.signal.aborted) setInspection(result);
        } catch (failure) {
            if (!controller.signal.aborted) {
                setInspection(null);
                setConnectionError(failure instanceof Error ? failure.message : "无法读取目标 ComfyUI");
            }
        } finally {
            if (request.current === controller) setChecking(false);
        }
    };
    const applyGraph = (text: string, preserve: boolean) => {
        try {
            if (new Blob([text]).size > 2 * 1024 * 1024) throw new Error("工作流 JSON 不能超过 2 MiB");
            const parsed = parseNativeComfyApiGraph(JSON.parse(text));
            const fields =
                preserve && flow
                    ? parsed.fields.map((field) => {
                          const old = flow.fields.find((candidate) => candidate.nodeId === field.nodeId && candidate.fieldName === field.fieldName && candidate.classType === field.classType);
                          return old ? { ...field, ...old, fieldValue: field.fieldValue } : field;
                      })
                    : parsed.fields;
            const keepOutput = preserve && flow && Boolean(parsed.graph[flow.outputNodeId]) && parsed.graph[flow.outputNodeId]?.class_type === flow.graph[flow.outputNodeId]?.class_type;
            setFlow({ ...parsed, fields, ...(keepOutput ? { outputNodeId: flow.outputNodeId, outputField: flow.outputField } : inferNativeComfyOutput(parsed.graph)) });
            setJSONMode(null);
            setJSONError("");
            setError("");
        } catch (failure) {
            setJSONError(failure instanceof SyntaxError ? "JSON 语法有误，请检查引号、逗号与括号。" : failure instanceof Error ? failure.message : "JSON 无效");
        }
    };
    const readFile = async (file: File) => {
        try {
            if (file.size > 2 * 1024 * 1024) throw new Error("工作流文件不能超过 2 MiB");
            applyGraph(await file.text(), false);
        } catch (failure) {
            setJSONError(failure instanceof Error ? failure.message : "读取文件失败");
        }
    };
    const openJSON = (mode: "paste" | "edit") => {
        setJSONMode(mode);
        setJSONText(mode === "edit" && flow ? JSON.stringify(flow.graph, null, 2) : "");
        setJSONError("");
    };
    const save = async () => {
        if (jsonMode) {
            setJSONError("请先应用或取消 JSON 编辑");
            return;
        }
        setError("");
        try {
            const prepared = prepareNativeComfyChannel(channel, profiles);
            setSaving(true);
            await onSave(prepared);
        } catch (failure) {
            if (channel.name.trim() && channel.baseUrl.trim()) {
                const invalid = profiles.find((profile) => !profile.displayName?.trim() || validateNativeComfyWorkflow(profile.comfyui));
                if (invalid) setPanel(invalid.model);
            }
            setError(failure instanceof Error ? failure.message : "保存失败，请重试");
            body.current?.scrollTo({ top: 0 });
        } finally {
            setSaving(false);
        }
    };
    const hasGraph = Boolean(flow && Object.keys(flow.graph).length);
    const missingNodes = flow && inspection ? [...new Set(Object.values(flow.graph).map((node) => String(node.class_type)))].filter((name) => !inspection.nodes[name]) : [];
    const status = checking ? "检查中" : inspection ? "已连接 · ComfyUI " + (inspection.stats.system?.comfyui_version || "") : connectionError ? "连接失败" : "尚未检查连接";
    const editInput = (input: ComfyInputControl, value: string | number | boolean) => {
        if (!flow) return;
        try {
            setFlow(updateNativeComfyInput(flow, input, value));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "参数无效");
        }
    };
    const renderInput = (input: ComfyInputControl) =>
        input.choices?.length ? (
            <Select
                aria-label={input.label + " " + input.nodeId}
                showSearch
                optionFilterProp="label"
                value={String(input.value)}
                disabled={input.bound || checking}
                options={input.choices.map((value) => ({ value, label: value }))}
                onChange={(value) => editInput(input, value)}
            />
        ) : typeof input.value === "number" ? (
            <InputNumber
                aria-label={input.label + " " + input.nodeId}
                value={input.value}
                min={input.min}
                max={input.max}
                step={input.step}
                disabled={input.bound}
                onChange={(value) => {
                    if (value !== null) editInput(input, value);
                }}
            />
        ) : typeof input.value === "boolean" ? (
            <Switch aria-label={input.label + " " + input.nodeId} checked={input.value} disabled={input.bound} onChange={(value) => editInput(input, value)} />
        ) : (
            <Input.TextArea aria-label={input.label + " " + input.nodeId} value={String(input.value)} autoSize={{ minRows: 1, maxRows: 5 }} disabled={input.bound} onChange={(event) => editInput(input, event.target.value)} />
        );
    return (
        <div className="native-comfy-sheet" aria-busy={saving}>
            <div className="native-comfy-main" ref={body} inert={saving}>
                {error && <Alert type="error" showIcon title={error} className="native-comfy-feedback" />}
                <section className="native-comfy-connection">
                    <div className="native-comfy-group-heading">
                        <h3>服务连接</h3>
                        <span role="status">
                            {inspection && <Check size={14} />}
                            {status}
                        </span>
                    </div>
                    <Form layout="vertical" requiredMark={false} className="native-comfy-connection-grid">
                        <Form.Item label="服务名称" htmlFor="native-comfy-name">
                            <Input
                                id="native-comfy-name"
                                aria-label="ComfyUI 服务名称"
                                value={channel.name}
                                placeholder="例如：图像工作站"
                                onChange={(event) => {
                                    setChannel({ ...channel, name: event.target.value });
                                    setError("");
                                }}
                            />
                        </Form.Item>
                        <Form.Item label="服务地址" htmlFor="native-comfy-url">
                            <Input
                                id="native-comfy-url"
                                aria-label="ComfyUI 服务地址"
                                inputMode="url"
                                value={channel.baseUrl}
                                placeholder="http://127.0.0.1:8188"
                                onChange={(event) => {
                                    setChannel({ ...channel, baseUrl: event.target.value });
                                    setError("");
                                }}
                            />
                        </Form.Item>
                        <Form.Item label="鉴权方式">
                            <Select aria-label="ComfyUI 鉴权方式" value="none" disabled options={[{ value: "none", label: "无需鉴权" }]} />
                        </Form.Item>
                        <Button loading={checking} disabled={!channel.baseUrl.trim()} onClick={() => void checkConnection()}>
                            检查连接
                        </Button>
                    </Form>
                    {connectionError && <Alert type="error" showIcon title={connectionError} />}
                </section>
                <section className="native-comfy-workflows">
                    <div className="native-comfy-group-heading">
                        <h3>
                            工作流 <span>{profiles.length}</span>
                        </h3>
                        <Dropdown trigger={["click"]} menu={{ items: NATIVE_USAGE_ORDER.map((key) => ({ key, label: MODEL_USAGE_LABELS[key] })), onClick: ({ key }) => addWorkflow(key as ModelUsage) }}>
                            <Button size="small" disabled={Boolean(jsonMode)} icon={<Plus size={14} />}>
                                添加工作流
                                <ChevronDown size={12} />
                            </Button>
                        </Dropdown>
                    </div>
                    {profiles.length > 1 && (
                        <div className="native-comfy-workflow-tabs" role="group" aria-label="选择工作流">
                            {profiles.map((profile, index) => (
                                <button type="button" key={profile.model} aria-pressed={panel === profile.model} onClick={() => selectPanel(profile.model)}>
                                    {profile.displayName || "未命名工作流 " + (index + 1)}
                                    <span>{profileUsageLabel(profile)}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {selected && flow ? (
                        <>
                            <Form layout="vertical" requiredMark={false} className="native-comfy-identity-grid">
                                <Form.Item label="工作流名称">
                                    <Input aria-label="工作流名称" value={selected.displayName || ""} onChange={(event) => setProfile({ displayName: event.target.value })} />
                                </Form.Item>
                                <Form.Item label="生成类型">
                                    <Select<NativeComfyCapability>
                                        aria-label="生成类型"
                                        value={selected.capability as NativeComfyCapability}
                                        options={Object.entries(LABELS).map(([value, label]) => ({ value: value as NativeComfyCapability, label }))}
                                        onChange={(capability) => setProfile({ capability, protocol: nativeComfyProtocolForCapability(capability), audioUses: capability === "audio" ? selected.audioUses || [] : undefined })}
                                    />
                                </Form.Item>
                                {selected.capability === "audio" && (
                                    <Form.Item label="音频用途">
                                        <Checkbox.Group
                                            aria-label="音频用途"
                                            options={Object.entries(AUDIO_USE_LABELS).map(([value, label]) => ({ value, label }))}
                                            value={audioUsesForProfile(selected)}
                                            onChange={(values) => setProfile({ audioUses: values as AudioModelUse[] })}
                                        />
                                    </Form.Item>
                                )}
                                <Popconfirm title="移除此工作流？" okText="移除" cancelText="取消" onConfirm={removeWorkflow}>
                                    <Button type="text" danger disabled={Boolean(jsonMode)} aria-label="移除当前工作流" icon={<Trash2 size={15} />} />
                                </Popconfirm>
                            </Form>
                            <div className="native-comfy-import">
                                <Upload size={18} />
                                <div>
                                    <strong>{hasGraph ? "已导入工作流" : "导入工作流"}</strong>
                                    <span>{hasGraph ? Object.keys(flow.graph).length + " 个节点" : "ComfyUI API JSON"}</span>
                                </div>
                                <Button size="small" disabled={Boolean(jsonMode)} onClick={() => fileInput.current?.click()}>
                                    {hasGraph ? "更换文件" : "选择文件"}
                                </Button>
                                <Button size="small" disabled={Boolean(jsonMode)} onClick={() => openJSON("paste")}>
                                    粘贴 JSON
                                </Button>
                                {hasGraph && (
                                    <Button size="small" type="text" disabled={Boolean(jsonMode)} icon={<Braces size={13} />} onClick={() => openJSON("edit")}>
                                        编辑 JSON
                                    </Button>
                                )}
                                <input
                                    hidden
                                    type="file"
                                    accept=".json,application/json"
                                    ref={fileInput}
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file) void readFile(file);
                                        event.target.value = "";
                                    }}
                                />
                            </div>
                            {jsonMode && (
                                <section className="native-comfy-json">
                                    <label htmlFor="native-comfy-json">{jsonMode === "edit" ? "编辑 API JSON" : "粘贴 API JSON"}</label>
                                    <Input.TextArea
                                        id="native-comfy-json"
                                        aria-label="工作流 JSON"
                                        value={jsonText}
                                        spellCheck={false}
                                        autoSize={{ minRows: 6, maxRows: 14 }}
                                        onChange={(event) => {
                                            setJSONText(event.target.value);
                                            setJSONError("");
                                        }}
                                    />
                                    <div>
                                        <Button
                                            onClick={() => {
                                                setJSONMode(null);
                                                setJSONError("");
                                            }}
                                        >
                                            取消编辑
                                        </Button>
                                        <Button type="primary" disabled={!jsonText.trim()} onClick={() => applyGraph(jsonText, jsonMode === "edit")}>
                                            检查并应用
                                        </Button>
                                    </div>
                                </section>
                            )}
                            {jsonError && <Alert type="error" showIcon title={jsonError} />}
                            {hasGraph ? (
                                <div className="native-comfy-config-grid">
                                    <section className="native-comfy-controls">
                                        <div className="native-comfy-group-heading">
                                            <h3>模型与参数</h3>
                                            <Button size="small" type="text" icon={<RefreshCw size={13} />} loading={checking} disabled={!channel.baseUrl.trim()} onClick={() => void checkConnection()}>
                                                读取模型选项
                                            </Button>
                                        </div>
                                        <Form layout="vertical" requiredMark={false}>
                                            {controls.models.map((input) => (
                                                <Form.Item
                                                    key={input.nodeId + ":" + input.fieldName}
                                                    label={input.label + " · #" + input.nodeId}
                                                    extra={input.bound ? "由输入映射控制" : inspection && input.choices && !input.choices.includes(String(input.value)) ? "目标服务未找到当前模型" : undefined}
                                                >
                                                    {input.choices ? renderInput(input) : <Input aria-label={input.label + " " + input.nodeId} readOnly value={String(input.value)} />}
                                                </Form.Item>
                                            ))}
                                            {!inspection && controls.models.length > 0 && <p className="native-comfy-help">检查连接后可选择目标服务中的模型。</p>}
                                            <div className="native-comfy-parameter-grid">
                                                {controls.parameters.map((input) => (
                                                    <Form.Item
                                                        key={input.nodeId + ":" + input.fieldName}
                                                        className={typeof input.value === "string" && !input.choices?.length ? "is-wide" : undefined}
                                                        label={input.label + " · #" + input.nodeId}
                                                        extra={input.bound ? "由输入映射控制" : undefined}
                                                    >
                                                        {renderInput(input)}
                                                    </Form.Item>
                                                ))}
                                            </div>
                                        </Form>
                                        {!controls.models.length && !controls.parameters.length && <p className="native-comfy-help">此工作流没有可编辑的固定参数。</p>}
                                        {missingNodes.length > 0 && <Alert type="warning" showIcon title={"目标服务缺少节点：" + missingNodes.join("、")} />}
                                    </section>
                                    <div className="native-comfy-bindings">
                                        <NativeComfyMappings key={panel} fields={flow.fields} onChange={(fields) => setFlow({ fields })} />
                                        <section className="native-comfy-output">
                                            <div className="native-comfy-group-heading">
                                                <h3>最终输出</h3>
                                            </div>
                                            <Form layout="vertical" requiredMark={false} className="native-comfy-output-grid">
                                                <Form.Item label="输出节点">
                                                    <Select
                                                        aria-label="最终输出节点"
                                                        showSearch
                                                        optionFilterProp="label"
                                                        placeholder="选择保存媒体的节点"
                                                        options={nativeComfyNodeOptions(flow.graph)}
                                                        value={flow.outputNodeId || undefined}
                                                        onChange={(outputNodeId) => {
                                                            const inferred = inferNativeComfyOutput({ [outputNodeId]: flow.graph[outputNodeId] });
                                                            setFlow({ outputNodeId, outputField: inferred.outputField });
                                                        }}
                                                    />
                                                </Form.Item>
                                                <Form.Item label="输出字段">
                                                    <Select
                                                        aria-label="输出字段"
                                                        value={flow.outputField || undefined}
                                                        placeholder="选择返回字段"
                                                        options={NATIVE_COMFY_OUTPUT_FIELDS.map((value) => ({ value, label: value }))}
                                                        onChange={(outputField) => setFlow({ outputField })}
                                                    />
                                                </Form.Item>
                                            </Form>
                                        </section>
                                    </div>
                                </div>
                            ) : (
                                <p className="native-comfy-empty">导入工作流后显示模型、参数和输入输出配置。</p>
                            )}
                            <details className="native-comfy-details">
                                <summary>执行选项</summary>
                                <Checkbox checked={flow.releaseModelsAfter === true} onChange={(event) => setFlow({ releaseModelsAfter: event.target.checked })}>
                                    完成后释放空闲服务的模型缓存
                                </Checkbox>
                            </details>
                        </>
                    ) : (
                        <div className="native-comfy-empty">添加工作流以配置模型与输入输出。</div>
                    )}
                </section>
            </div>
            <footer className="native-comfy-footer">
                <span>{profiles.length} 个工作流</span>
                <div>
                    <Button disabled={saving} onClick={onClose}>
                        取消
                    </Button>
                    <Button type="primary" loading={saving} disabled={Boolean(jsonMode)} onClick={() => void save()}>
                        保存全部配置
                    </Button>
                </div>
            </footer>
        </div>
    );
}
