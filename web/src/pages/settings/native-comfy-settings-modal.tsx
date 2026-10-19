import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Dropdown, Form, Input, InputNumber, Popconfirm, Segmented, Select } from "antd";
import { AudioLines, Braces, Check, ChevronDown, Image, Plus, RefreshCw, Server, Trash2, Upload, Video, Workflow } from "lucide-react";
import { ModelEditorModal } from "@/components/model-editor-modal";
import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
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
} from "@/lib/model-settings-catalog";
import { createModelChannel, type ModelChannel, type AudioModelUse } from "@/stores/use-config-store";
import { inspectNativeComfyUI, type NativeComfyInspection } from "@/services/api/native-comfyui";
import "./native-comfy-settings.css";

const LABELS: Record<NativeComfyCapability, string> = { image: "图片", video: "视频", audio: "音频" };
const ICONS = { image: Image, video: Video, audio: AudioLines };
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
    open,
    initial,
    initialCapability = "image",
    initialUsage = initialCapability,
    onClose,
    onSave,
}: {
    open: boolean;
    initial: ModelChannel | null;
    initialCapability?: NativeComfyCapability;
    initialUsage?: ModelUsage;
    onClose: () => void;
    onSave: (channel: ModelChannel) => Promise<void>;
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
        setPanel(initial ? (next.profiles.find((profile) => profileMatchesUsage(profile, initialUsage)) || next.profiles[0]).model : "connection");
        setJSONMode(null);
        setError("");
        setJSONError("");
    }, [initial, initialCapability, initialUsage, open]);
    useEffect(() => {
        request.current?.abort();
        setInspection(null);
        setChecking(false);
        setConnectionError("");
        return () => request.current?.abort();
    }, [channel.baseUrl]);
    const selected = profiles.find((profile) => profile.model === panel);
    const flow = selected?.comfyui;
    const controls = useMemo(() => (flow ? nativeComfyInputControls(flow, inspection?.nodes) : { models: [], parameters: [] }), [flow, inspection]);
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
            if (!channel.name.trim() || !channel.baseUrl.trim()) setPanel("connection");
            else {
                const invalid = profiles.find((profile) => !profile.displayName?.trim() || validateNativeComfyWorkflow(profile.comfyui));
                setPanel(invalid ? invalid.model : "connection");
            }
            setError(failure instanceof Error ? failure.message : "保存失败，请重试");
            body.current?.scrollTo({ top: 0 });
        } finally {
            setSaving(false);
        }
    };
    const hasGraph = Boolean(flow && Object.keys(flow.graph).length);
    const missingNodes = flow && inspection ? [...new Set(Object.values(flow.graph).map((node) => String(node.class_type)))].filter((name) => !inspection.nodes[name]) : [];
    const status = checking ? "正在连接…" : inspection ? "已连接 · ComfyUI " + (inspection.stats.system?.comfyui_version || "") : connectionError ? "连接失败" : "尚未检查连接";
    return (
        <ModelEditorModal
            open={open}
            title={initial ? "管理 ComfyUI 服务" : "添加 ComfyUI 服务"}
            subtitle="服务连接共用；每个工作流独立设置生成类型与参数。"
            rootClassName="native-comfy-modal"
            busy={saving}
            onClose={onClose}
            footer={
                <div className="native-comfy-footer">
                    <span>{profiles.length} 个工作流 · 修改在保存后生效</span>
                    <div>
                        <Button disabled={saving} onClick={onClose}>
                            取消
                        </Button>
                        <Button type="primary" loading={saving} disabled={Boolean(jsonMode)} onClick={() => void save()}>
                            保存全部更改
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="native-comfy-layout" inert={saving} aria-busy={saving}>
                <aside className="native-comfy-sidebar" aria-label="ComfyUI 配置导航">
                    <button type="button" className={"native-comfy-nav " + (panel === "connection" ? "is-selected" : "")} aria-current={panel === "connection" ? "page" : undefined} onClick={() => selectPanel("connection")}>
                        <Server size={18} />
                        <span>
                            <strong>服务连接</strong>
                            <small>{channel.name || "设置地址与名称"}</small>
                        </span>
                    </button>
                    <div className="native-comfy-list-heading">
                        <span>工作流</span>
                        <span>{profiles.length}</span>
                    </div>
                    <div className="native-comfy-workflows">
                        {profiles.map((profile, index) => {
                            const Icon = ICONS[profile.capability as NativeComfyCapability] || Workflow;
                            return (
                                <button type="button" key={profile.model} className={"native-comfy-nav " + (panel === profile.model ? "is-selected" : "")} aria-pressed={panel === profile.model} onClick={() => selectPanel(profile.model)}>
                                    <Icon size={17} />
                                    <span>
                                        <strong>{profile.displayName || "未命名工作流 " + (index + 1)}</strong>
                                        <small>
                                            {profileUsageLabel(profile)}
                                            {validateNativeComfyWorkflow(profile.comfyui) ? " · 待配置" : ""}
                                        </small>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <Dropdown trigger={["click"]} menu={{ items: NATIVE_USAGE_ORDER.map((key) => ({ key, label: MODEL_USAGE_LABELS[key] + "工作流" })), onClick: ({ key }) => addWorkflow(key as ModelUsage) }}>
                        <Button className="native-comfy-add" icon={<Plus size={15} />}>
                            添加工作流
                            <ChevronDown size={13} />
                        </Button>
                    </Dropdown>
                    <p className="native-comfy-sidebar-note">已有任务和默认模型继续使用原工作流标识。</p>
                </aside>
                <div className="native-comfy-main" ref={body}>
                    {error && <Alert type="error" showIcon title={error} className="native-comfy-feedback" />}
                    {panel === "connection" ? (
                        <>
                            <header className="native-comfy-section-heading">
                                <span className="native-comfy-eyebrow">COMFYUI · 服务</span>
                                <h2>连接你的 ComfyUI</h2>
                                <p>连接已运行的本机或局域网服务，再为不同用途添加工作流。</p>
                            </header>
                            <Form layout="vertical" requiredMark={false} className="native-comfy-connection-form">
                                <Form.Item label="服务名称" htmlFor="native-comfy-name">
                                    <Input
                                        id="native-comfy-name"
                                        placeholder="例如：局域网生成服务"
                                        value={channel.name}
                                        onChange={(event) => {
                                            setChannel({ ...channel, name: event.target.value });
                                            setError("");
                                        }}
                                    />
                                </Form.Item>
                                <Form.Item label="服务地址" htmlFor="native-comfy-url" extra="填写主机和端口，不添加 /prompt 或 /api 路径。">
                                    <Input
                                        id="native-comfy-url"
                                        inputMode="url"
                                        placeholder="http://127.0.0.1:8188"
                                        value={channel.baseUrl}
                                        onChange={(event) => {
                                            setChannel({ ...channel, baseUrl: event.target.value });
                                            setError("");
                                        }}
                                    />
                                </Form.Item>
                                <div className="native-comfy-connection-check">
                                    <Button loading={checking} disabled={!channel.baseUrl.trim()} onClick={() => void checkConnection()}>
                                        检查连接
                                    </Button>
                                    <span role="status" className={inspection ? "is-connected" : ""}>
                                        {inspection && <Check size={14} />}
                                        {status}
                                    </span>
                                </div>
                                {connectionError && <Alert type="error" showIcon title={connectionError} />}
                                <p className="native-comfy-help">只读取服务版本和节点清单，不提交生成任务。安装模型和节点后，可重新检查。</p>
                                <details className="native-comfy-details">
                                    <summary>连接说明</summary>
                                    <p>当前表单用于无需鉴权的原生服务。模型和自定义节点由目标 ComfyUI 管理，当前工作区读取的是目标服务的节点清单。</p>
                                </details>
                            </Form>
                            <div className="native-comfy-next">
                                <div>
                                    <strong>接下来，配置工作流</strong>
                                    <p>图片、视频和音频可以共用一个服务连接。</p>
                                </div>
                                <Button disabled={!profiles.length} onClick={() => selectPanel(profiles[0].model)}>
                                    配置第一个工作流
                                </Button>
                            </div>
                        </>
                    ) : selected && flow ? (
                        <>
                            <header className="native-comfy-section-heading native-comfy-workflow-heading">
                                <div>
                                    <span className="native-comfy-eyebrow">COMFYUI · 工作流</span>
                                    <h2>{selected.displayName || "配置新工作流"}</h2>
                                </div>
                                <Popconfirm title="移除这个工作流？" description="保存后更新默认模型选择；已有任务与素材保留。" okText="移除" cancelText="取消" onConfirm={removeWorkflow}>
                                    <Button type="text" danger aria-label="移除当前工作流" icon={<Trash2 size={16} />} />
                                </Popconfirm>
                            </header>
                            <Form layout="vertical" requiredMark={false}>
                                <div className="native-comfy-identity-grid">
                                    <Form.Item label="工作流名称" htmlFor="native-workflow-name">
                                        <Input id="native-workflow-name" placeholder="例如：产品图生成" value={selected.displayName || ""} onChange={(event) => setProfile({ displayName: event.target.value })} />
                                    </Form.Item>
                                    <Form.Item label="输出媒体类型">
                                        <Segmented
                                            block
                                            aria-label="工作流生成类型"
                                            value={selected.capability}
                                            options={(Object.keys(LABELS) as NativeComfyCapability[]).map((value) => ({ value, label: LABELS[value] }))}
                                            onChange={(value) => setProfile({ capability: value as NativeComfyCapability, protocol: nativeComfyProtocolForCapability(value as NativeComfyCapability) })}
                                        />
                                    </Form.Item>
                                </div>
                                {selected.capability === "audio" && (
                                    <Form.Item label="音频用途" extra="按实际能力选择，可多选。未设置时归入“其他音频”。">
                                        <Checkbox.Group
                                            aria-label="音频用途"
                                            value={audioUsesForProfile(selected)}
                                            options={Object.entries(AUDIO_USE_LABELS).map(([value, label]) => ({ value, label }))}
                                            onChange={(values) => setProfile({ audioUses: values as AudioModelUse[] })}
                                        />
                                    </Form.Item>
                                )}
                            </Form>
                            <section className={"native-comfy-import " + (!hasGraph ? "is-empty" : "")} aria-label="导入工作流">
                                <div>
                                    <Upload size={18} />
                                    <div>
                                        <strong>{hasGraph ? "已导入 · " + Object.keys(flow.graph).length + " 个节点" : "导入 ComfyUI 工作流"}</strong>
                                        <p>{hasGraph ? "继续设置模型文件、常用参数与输出。" : "使用 ComfyUI 导出的 API 格式 JSON 文件。"}</p>
                                    </div>
                                </div>
                                <div>
                                    <Button disabled={Boolean(jsonMode)} onClick={() => fileInput.current?.click()}>
                                        {hasGraph ? "更换文件" : "选择文件"}
                                    </Button>
                                    <Button disabled={Boolean(jsonMode)} icon={<Braces size={14} />} onClick={() => openJSON("paste")}>
                                        粘贴 JSON
                                    </Button>
                                </div>
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
                            </section>
                            {jsonMode && (
                                <section className="native-comfy-json" aria-label="工作流 JSON 编辑">
                                    <label htmlFor="native-comfy-json">{jsonMode === "edit" ? "编辑 API JSON" : "粘贴 API JSON"}</label>
                                    <Input.TextArea
                                        id="native-comfy-json"
                                        value={jsonText}
                                        spellCheck={false}
                                        autoSize={{ minRows: 9, maxRows: 16 }}
                                        onChange={(event) => {
                                            setJSONText(event.target.value);
                                            setJSONError("");
                                        }}
                                        placeholder={'{ "1": { "class_type": "…", "inputs": {} } }'}
                                    />
                                    <p>检查并应用后仍需保存。{jsonMode === "paste" && hasGraph ? "新 JSON 会替换当前工作流。" : ""}</p>
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
                            {hasGraph && (
                                <>
                                    <section className="native-comfy-group">
                                        <div className="native-comfy-group-heading">
                                            <div>
                                                <h3>目标服务模型</h3>
                                                <p>模型文件来自当前服务的节点清单。</p>
                                            </div>
                                            <Button size="small" type="text" icon={<RefreshCw size={13} />} loading={checking} disabled={!channel.baseUrl.trim()} onClick={() => void checkConnection()}>
                                                读取模型选项
                                            </Button>
                                        </div>
                                        {controls.models.length ? (
                                            <Form layout="vertical" requiredMark={false}>
                                                <div className="native-comfy-input-grid">
                                                    {controls.models.map((input) => (
                                                        <Form.Item
                                                            key={input.nodeId + ":" + input.fieldName}
                                                            label={input.label + " · #" + input.nodeId}
                                                            extra={
                                                                input.bound ? "由任务参数或随机策略控制，见高级设置。" : inspection && input.choices && !input.choices.includes(String(input.value)) ? "目标服务中未找到当前文件，请选择兼容模型。" : undefined
                                                            }
                                                        >
                                                            {input.choices ? (
                                                                <Select
                                                                    aria-label={input.label + " " + input.nodeId}
                                                                    showSearch
                                                                    optionFilterProp="label"
                                                                    value={String(input.value)}
                                                                    disabled={input.bound || checking}
                                                                    options={input.choices.map((value) => ({ value, label: value }))}
                                                                    onChange={(value) => setProfile({ comfyui: updateNativeComfyInput(flow, input, value) })}
                                                                />
                                                            ) : (
                                                                <Input aria-label={input.label + " " + input.nodeId} readOnly value={String(input.value)} />
                                                            )}
                                                        </Form.Item>
                                                    ))}
                                                </div>
                                            </Form>
                                        ) : (
                                            <p className="native-comfy-help">这份工作流没有可直接选择的模型文件。</p>
                                        )}
                                        {!inspection && <p className="native-comfy-help">检查连接后可选择目标服务中的模型；当前仍保留工作流内的文件名。</p>}
                                        {connectionError && <Alert type="error" showIcon title={connectionError} />}
                                        {missingNodes.length > 0 && <Alert type="warning" showIcon title={"目标服务缺少节点：" + missingNodes.join("、")} />}
                                    </section>
                                    {controls.parameters.length > 0 && (
                                        <section className="native-comfy-group">
                                            <div className="native-comfy-group-heading">
                                                <div>
                                                    <h3>常用参数</h3>
                                                    <p>修改工作流默认值。标注为映射的字段由任务参数或随机策略控制。</p>
                                                </div>
                                            </div>
                                            <Form layout="vertical" requiredMark={false}>
                                                <div className="native-comfy-parameter-grid">
                                                    {controls.parameters.map((input) => (
                                                        <Form.Item key={input.nodeId + ":" + input.fieldName} label={input.label + " · #" + input.nodeId} extra={input.bound ? "由任务参数或随机策略控制" : undefined}>
                                                            <InputNumber
                                                                aria-label={input.label + " " + input.nodeId}
                                                                value={Number(input.value)}
                                                                min={input.min}
                                                                max={input.max}
                                                                step={input.step}
                                                                disabled={input.bound}
                                                                onChange={(value) => {
                                                                    if (value !== null) setProfile({ comfyui: updateNativeComfyInput(flow, input, value) });
                                                                }}
                                                            />
                                                        </Form.Item>
                                                    ))}
                                                </div>
                                            </Form>
                                        </section>
                                    )}
                                    <section className="native-comfy-group">
                                        <div className="native-comfy-group-heading">
                                            <div>
                                                <h3>输出结果</h3>
                                                <p>选择最终保存媒体的节点。多个输出时请明确指定。</p>
                                            </div>
                                        </div>
                                        <Form layout="vertical" requiredMark={false}>
                                            <Form.Item label="最终输出节点" extra={!flow.outputField ? "未识别输出文件字段，请在高级设置中选择。" : undefined}>
                                                <Select
                                                    aria-label="最终输出节点"
                                                    showSearch
                                                    optionFilterProp="label"
                                                    placeholder="选择保存图片、视频或音频的节点"
                                                    options={nativeComfyNodeOptions(flow.graph)}
                                                    value={flow.outputNodeId || undefined}
                                                    onChange={(outputNodeId) => {
                                                        const inferred = inferNativeComfyOutput({ [outputNodeId]: flow.graph[outputNodeId] });
                                                        setFlow({ outputNodeId, outputField: inferred.outputField });
                                                    }}
                                                />
                                            </Form.Item>
                                        </Form>
                                    </section>
                                    <details className="native-comfy-details" key={panel}>
                                        <summary>高级设置 · 输出字段与输入映射</summary>
                                        <div className="native-comfy-advanced">
                                            <Button size="small" icon={<Braces size={13} />} disabled={Boolean(jsonMode)} onClick={() => openJSON("edit")}>
                                                编辑 API JSON
                                            </Button>
                                            <Form layout="vertical" requiredMark={false}>
                                                <Form.Item label="输出字段" extra="保留保存节点实际返回的字段；视频节点也可能使用 images。">
                                                    <Select
                                                        aria-label="输出字段"
                                                        value={flow.outputField || undefined}
                                                        placeholder="选择返回文件描述的字段"
                                                        options={NATIVE_COMFY_OUTPUT_FIELDS.map((value) => ({ value, label: value }))}
                                                        onChange={(outputField) => setFlow({ outputField })}
                                                    />
                                                </Form.Item>
                                            </Form>
                                            <Checkbox checked={flow.releaseModelsAfter === true} onChange={(event) => setFlow({ releaseModelsAfter: event.target.checked })}>
                                                工作流完成后释放空闲服务的模型缓存
                                            </Checkbox>
                                            <p className="native-comfy-help">仅用于多个实例共享显卡的场景，目标队列不为空时跳过释放。</p>
                                            <WorkflowGraphEditor workflowJson={flow.graph} fields={flow.fields} onChange={(fields) => setFlow({ fields })} />
                                        </div>
                                    </details>
                                </>
                            )}
                        </>
                    ) : (
                        <p>从左侧添加一个工作流。</p>
                    )}
                </div>
            </div>
        </ModelEditorModal>
    );
}
