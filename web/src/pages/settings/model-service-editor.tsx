import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Form, Input, Select, Spin } from "antd";
import { Check, ChevronDown, Search, Settings2 } from "lucide-react";
import { ChannelHeadersEditor, validateChannelHeaders } from "@/components/channel-headers-editor";
import { fetchChannelModels, type ChannelModelFetchResult } from "@/services/api/image-models";
import { fetchPluginProviderCatalog } from "@/services/api/plugin-catalog";
import { mergeFetchedChannelModelProfiles, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";
import { serviceConnectionError, serviceModelProfile } from "@/lib/model-service-presets";
import { MODEL_USAGE_LABELS, MODEL_USAGE_ORDER, modelUsageCapability, profileMatchesUsage, profileUsageLabel, withProfileUsage, type ModelUsage } from "@/lib/model-settings-catalog";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { seedancePortraitLabel } from "@/lib/seedance-portrait";
import { createModelChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ChannelModelSettings } from "./channel-model-settings";
import { currentModelConnectionReceipt, useModelConnectionTests } from "@/stores/use-model-connection-tests";
import "./model-service-editor.css";
import { getTransportFailureKind } from "@/services/api/request";

export function ModelServiceEditor({
    initial,
    initialCapability,
    initialUsage = initialCapability || "all",
    onClose,
    onSave,
    onDraftChange,
    onBusyChange,
}: {
    initial?: ModelChannel;
    initialCapability?: ModelCapability;
    initialUsage?: ModelUsage;
    onClose: () => void;
    onSave: (channel: ModelChannel) => Promise<void>;
    onDraftChange: (channel: ModelChannel) => void;
    onBusyChange: (busy: boolean) => void;
}) {
    const [draft, setDraft] = useState<ModelChannel>(() => (initial ? structuredClone(initial) : { ...createModelChannel(), name: "", baseUrl: "" }));
    const [advanced, setAdvanced] = useState(false);
    const [catalog, setCatalog] = useState<ChannelModelCatalogItem[]>(() => (initial?.models || []).map((id) => ({ id })));
    const [catalogRead, setCatalogRead] = useState(false);
    const [protocols, setProtocols] = useState<ModelProtocolDefinition[]>([]);
    const [protocolLoading, setProtocolLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const catalogRequest = useRef<AbortController | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<ModelUsage>(initialUsage);
    const [manualName, setManualName] = useState("");
    const [manualUsage, setManualUsage] = useState<ModelUsage>(initialUsage === "all" ? "text" : initialUsage);
    const [editingCapabilities, setEditingCapabilities] = useState(false);
    const alive = useRef(true);
    const receipts = useModelConnectionTests((state) => state.receipts);

    useEffect(() => {
        alive.current = true;
        void fetchPluginProviderCatalog("user.custom-channel")
            .then((items) => {
                if (alive.current) setProtocols(items);
            })
            .catch(() => {
                if (alive.current) setError("无法读取模型能力，请关闭后重试");
            })
            .finally(() => {
                if (alive.current) setProtocolLoading(false);
            });
        return () => {
            alive.current = false;
            catalogRequest.current?.abort();
        };
    }, []);

    const patch = (value: Partial<ModelChannel>) => {
        setDraft((current) => ({ ...current, ...value }));
        setError("");
        setCatalogRead(false);
    };
    const validateConnection = (requireCredential = true) => {
        const problem = serviceConnectionError(draft, { protocols, requireCredential }) || validateChannelHeaders(draft.headers);
        if (problem) setError(problem);
        return !problem;
    };
    const applyCatalog = (result: ChannelModelFetchResult) => {
        const byId = new Map(catalog.map((item) => [item.id, item]));
        for (const item of result.catalog) byId.set(item.id, item);
        for (const id of result.models) if (!byId.has(id)) byId.set(id, { id });
        const next = [...byId.values()];
        const profiles = next.map((item) => serviceModelProfile(draft, item, protocols));
        // Catalog refresh enriches new entries; explicitly configured profiles win.
        const enriched = mergeFetchedChannelModelProfiles({ ...draft, modelProfiles: [] }, result.catalog);
        const existing = new Set(draft.modelProfiles?.map((item) => item.model));
        setDraft((current) => ({
            ...current,
            modelProfiles: profiles.map((profile) => {
                const metadata = enriched.find((item) => item.model === profile.model);
                return existing.has(profile.model) || !metadata?.capabilityConfig ? profile : { ...profile, capabilityConfig: metadata.capabilityConfig };
            }),
        }));
        setCatalog(next);
        setCatalogRead(true);
        setNotice(result.models.length ? `已读取 ${result.models.length} 个模型，勾选你要使用的模型。` : "服务未返回模型，可以手动添加模型 ID。");
    };
    const fetchModels = async () => {
        if (!validateConnection()) return;
        catalogRequest.current?.abort();
        const request = new AbortController();
        catalogRequest.current = request;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            const result = await fetchChannelModels(draft, true, request.signal);
            if (alive.current && !request.signal.aborted) applyCatalog(result);
        } catch (failure) {
            if (alive.current && !request.signal.aborted) {
                setError(getTransportFailureKind(failure) === "timeout" ? "读取模型目录超时，请检查地址和网络后重试" : failure instanceof Error ? failure.message : "读取模型失败");
                setNotice("部分服务不提供模型目录，你仍可手动添加模型 ID。");
            }
        } finally {
            if (alive.current) setBusy(false);
        }
    };
    const toggleModel = (id: string, enabled: boolean) => {
        const item = catalog.find((candidate) => candidate.id === id) || { id };
        const profile = serviceModelProfile(draft, item, protocols);
        setDraft((current) => ({ ...current, models: enabled ? [...new Set([...current.models, id])] : current.models.filter((model) => model !== id), modelProfiles: [...(current.modelProfiles || []).filter((p) => p.model !== id), profile] }));
        if (enabled && !profile.protocol) {
            setNotice("请在高级模型设置中，按服务商文档选择请求协议。视频接口的地址和格式可能不同。");
            setEditingCapabilities(true);
        }
        setError("");
    };
    const addManual = () => {
        const id = manualName.trim();
        if (!id) return;
        if (draft.models.includes(id)) {
            setError("这个模型已在列表中");
            return;
        }
        const manualCapability = modelUsageCapability(manualUsage)!;
        const intent = withProfileUsage({ model: id, capability: manualCapability }, manualUsage);
        const profile = serviceModelProfile({ ...draft, modelProfiles: [...(draft.modelProfiles || []), intent] }, { id }, protocols, manualCapability);
        if (!profile.protocol) {
            setNotice("请在高级模型设置中，为这个模型选择服务商要求的请求协议。");
            setEditingCapabilities(true);
        }
        setCatalog((current) => (current.some((item) => item.id === id) ? current : [...current, { id, modelType: manualCapability }]));
        setDraft((current) => ({ ...current, models: [...current.models, id], modelProfiles: [...(current.modelProfiles || []).filter((p) => p.model !== id), profile] }));
        setManualName("");
        setError("");
    };
    const save = async () => {
        if (!validateConnection()) return;
        if (!draft.models.length) {
            setError("请至少选择或添加一个模型");
            return;
        }
        const profiles = draft.models.map((id) => serviceModelProfile(draft, catalog.find((item) => item.id === id) || { id }, protocols));
        const missing = profiles.find((profile) => !profile.protocol);
        if (missing) {
            setError(`${missing.model} 还需要选择请求协议，请打开高级模型设置`);
            setEditingCapabilities(true);
            return;
        }
        setBusy(true);
        setSaving(true);
        setError("");
        try {
            await onSave({ ...draft, name: draft.name.trim() || "我的模型服务", baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""), apiKey: draft.apiKey.trim(), modelProfiles: profiles });
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "保存失败，请重试");
        } finally {
            if (alive.current) {
                setBusy(false);
                setSaving(false);
            }
        }
    };
    useEffect(() => {
        onDraftChange(draft);
    }, [draft, onDraftChange]);
    useEffect(() => {
        onBusyChange(busy);
    }, [busy, onBusyChange]);
    const visibleModels = catalog.filter((item) => {
        const profile = serviceModelProfile(draft, item, protocols);
        return `${item.id} ${seedancePortraitLabel(item.id) || item.displayName || ""}`.toLowerCase().includes(query.toLowerCase()) && profileMatchesUsage(profile, filter);
    });

    return (
        <div className="api-service-sheet" aria-busy={busy}>
            <div className="api-service-scroll" inert={busy}>
                <section className="api-service-connection">
                    <h3>服务连接</h3>
                    <Form layout="vertical" requiredMark={false} disabled={busy}>
                        <Form.Item label="服务名称">
                            <Input aria-label="服务名称" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                        </Form.Item>
                        <Form.Item label="服务地址">
                            <Input aria-label="服务地址" inputMode="url" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
                        </Form.Item>
                        <Form.Item label="API Key">
                            <Input.Password aria-label="API Key" autoComplete="new-password" placeholder={draft.hasApiKey ? "已配置，留空保留" : "输入服务提供的密钥"} value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} />
                        </Form.Item>
                    </Form>
                    <button type="button" className="model-service-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                        <Settings2 size={14} />
                        连接选项
                        <ChevronDown size={12} />
                    </button>
                    {advanced && (
                        <Form layout="vertical" requiredMark={false} className="model-service-advanced-fields">
                            <Form.Item label="素材服务地址">
                                <Input aria-label="素材服务地址" inputMode="url" value={draft.referenceAssetOrigin || ""} onChange={(event) => patch({ referenceAssetOrigin: event.target.value })} />
                            </Form.Item>
                            <Form.Item label="目录接口格式">
                                <Select
                                    aria-label="目录接口格式"
                                    value={draft.apiFormat}
                                    options={[
                                        { value: "openai", label: "OpenAI 兼容" },
                                        { value: "gemini", label: "Gemini 原生" },
                                    ]}
                                    onChange={(apiFormat) => patch({ apiFormat })}
                                />
                            </Form.Item>
                            <Form.Item label="Secret Key">
                                <Input.Password aria-label="Secret Key" autoComplete="new-password" value={draft.secretKey} onChange={(event) => patch({ secretKey: event.target.value })} />
                            </Form.Item>
                            <ChannelHeadersEditor value={draft.headers} onChange={(headers) => patch({ headers })} />
                        </Form>
                    )}
                </section>
                <section className="api-service-models">
                    <div className="model-service-catalog-header">
                        <h3>
                            模型 <span>{draft.models.length}</span>
                        </h3>
                        <Button size="small" loading={busy} disabled={protocolLoading} onClick={() => void fetchModels()}>
                            读取模型
                        </Button>
                    </div>
                    <Input aria-label="搜索模型" prefix={<Search size={15} />} placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.target.value)} allowClear />
                    <div className="model-service-filter">
                        <div className="model-service-usage" role="group" aria-label="按用途筛选模型">
                            {MODEL_USAGE_ORDER.map((value) => (
                                <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                                    {MODEL_USAGE_LABELS[value]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="model-service-catalog">
                        {protocolLoading ? (
                            <Spin />
                        ) : visibleModels.length ? (
                            visibleModels.map((item) => {
                                const profile = serviceModelProfile(draft, item, protocols);
                                const receipt = currentModelConnectionReceipt(receipts, draft, item.id);
                                const displayName = seedancePortraitLabel(item.id) || item.displayName || item.id;
                                return (
                                    <label key={item.id} className="model-service-model">
                                        <Checkbox checked={draft.models.includes(item.id)} onChange={(event) => toggleModel(item.id, event.target.checked)} />
                                        <span>
                                            <strong>{displayName}</strong>
                                            {displayName !== item.id && <small>{item.id}</small>}
                                        </span>
                                        <span className="model-service-kind">{profileUsageLabel(profile)}</span>
                                        <small title={receipt?.detail}>{receipt ? (receipt.success ? "测试通过" : "测试失败") : ""}</small>
                                    </label>
                                );
                            })
                        ) : (
                            <p className="api-service-empty">{query ? "没有匹配的模型" : "读取模型目录，或手动添加模型 ID。"}</p>
                        )}
                    </div>
                    <div className="model-service-manual">
                        <Input aria-label="模型 ID" placeholder="模型 ID" value={manualName} onChange={(event) => setManualName(event.target.value)} onPressEnter={addManual} />
                        <Select aria-label="模型类型" value={manualUsage} onChange={setManualUsage} options={MODEL_USAGE_ORDER.filter((value) => value !== "all").map((value) => ({ value, label: MODEL_USAGE_LABELS[value] }))} />
                        <Button disabled={protocolLoading || !manualName.trim()} onClick={addManual}>
                            添加
                        </Button>
                    </div>
                    {draft.models.length > 0 && (
                        <>
                            <button type="button" className="model-service-advanced" aria-expanded={editingCapabilities} onClick={() => setEditingCapabilities(!editingCapabilities)}>
                                <Settings2 size={14} />
                                模型协议、参数与测试
                                <ChevronDown size={12} />
                            </button>
                            {editingCapabilities && <ChannelModelSettings draft channel={draft} onChange={(modelProfiles) => setDraft((current) => ({ ...current, modelProfiles }))} />}
                        </>
                    )}
                </section>
                {(error || notice) && (
                    <div className="model-service-feedback">
                        {error && <Alert type="error" showIcon title={error} />}
                        {notice && <Alert type="info" showIcon title={notice} />}
                    </div>
                )}
            </div>
            <footer className="native-comfy-footer">
                <span>{catalogRead ? "已读取模型目录" : draft.models.length + " 个模型"}</span>
                <div>
                    <Button disabled={saving} onClick={onClose}>
                        取消
                    </Button>
                    <Button type="primary" loading={saving} disabled={busy || !draft.models.length || protocolLoading} icon={<Check size={14} />} onClick={() => void save()}>
                        保存配置
                    </Button>
                </div>
            </footer>
        </div>
    );
}
