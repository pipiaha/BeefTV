import { Alert, App, Button, Dropdown, Input, Popconfirm, Select, Switch } from "antd";
import { Bug, ChevronDown, Plus, RefreshCw, Search, Trash2, Workflow } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { validateChannelHeaders } from "@/components/channel-headers-editor";
import { isNativeComfyChannel, MODEL_USAGE_LABELS, MODEL_USAGE_ORDER, modelsForUsage, profileUsageLabel, type ModelUsage } from "@/lib/model-settings-catalog";
import { mergeFetchedChannelModelProfiles } from "@/lib/channel-model-catalog";
import { seedancePortraitModel } from "@/lib/seedance-portrait";
import { fetchChannelModels, type ChannelModelFetchResult } from "@/services/api/image";
import {
    channelHasGenerationCredential,
    channelHasManagedBeefAPICredential,
    defaultBaseUrlForApiFormat,
    encodeChannelModel,
    filterModelsByCapability,
    isBuiltinBeefAPIChannel,
    modelOptionsFromChannels,
    normalizeConfigSnapshot,
    useConfigStore,
    useEffectiveConfig,
    type AiConfig,
    type ModelChannel,
} from "@/stores/use-config-store";
import { ModelServiceDialog } from "./model-service-dialog";
import { ModelDefaultGrid } from "./model-default-grid";
import { currentModelConnectionReceipt, useModelConnectionTests } from "@/stores/use-model-connection-tests";
import { ModelLogo } from "@/components/model-logo";
import beefTVAppIcon from "../../../../assets/app-icon.png";
import { MODEL_SERVICE_PRESETS, isTopazUpscaleChannel, channelAllowsEmptyAPIKey, modelCatalogRequestURL, servicePresetFor } from "@/lib/model-service-presets";
import { workspaceCapabilities } from "@/services/workspace-mode";
import { localWorkspaceConfig } from "@/lib/user-session";
import { getLocalModelConfig } from "@/services/api/workspace";
import { commitModelConfig, flushModelConfig, getModelConfigPersistenceState, subscribeModelConfigPersistence, type ModelConfigPersistenceState } from "@/services/model-config-repository";
import { createChannelCatalogRequests } from "@/services/channel-catalog-requests";
import { getTransportFailureKind } from "@/services/api/request";
import { beefAPIConnectionLabel, cancelBeefAPIConnection, disconnectBeefAPIConnection, getBeefAPIConnection, openBeefAPIWallet, startBeefAPIConnection, type BeefAPIConnectionSummary } from "@/services/api/beefapi-connection";
import { recordChannelDelete, recordChannelDeleteConfirmOpen } from "./model-settings-diagnostics";
import "./model-settings.css";

type UserChannelConnection = "openai" | "gemini";
type ChannelSettingsPaneProps = {
    onOpenDiagnostics?: () => void;
    onOpenRunningHub?: () => void;
};

export function ChannelSettingsPane({ onOpenDiagnostics, onOpenRunningHub }: ChannelSettingsPaneProps) {
    const { message } = App.useApp();
    const localMode = workspaceCapabilities().local;
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const persistence = useSyncExternalStore(subscribeModelConfigPersistence, getModelConfigPersistenceState, getModelConfigPersistenceState);
    const [usage, setUsage] = useState<ModelUsage>("all");
    const [loadingChannelIds, setLoadingChannelIds] = useState<string[]>([]);
    const [serviceEditor, setServiceEditor] = useState<ModelChannel | null | undefined>(undefined);
    const [modelFocus, setModelFocus] = useState<string | undefined>();
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState<string[]>([]);
    const effectiveConfig = useEffectiveConfig();
    const [beefConnection, setBeefConnection] = useState<BeefAPIConnectionSummary | null>(null);
    const [beefBusy, setBeefBusy] = useState(false);
    const appliedConnectionState = useRef<string | undefined>(undefined);
    const catalogSync = useRef<{ state: string; selection: string; adopt: boolean } | null>(null);
    const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);
    const requests = useRef(createChannelCatalogRequests());
    const deleting = useRef(new Set<string>());
    const [deleteFailures, setDeleteFailures] = useState<Record<string, string>>({});
    useEffect(() => () => requests.current.cancelAll(), []);
    const cancelCatalog = (id: string) => {
        requests.current.cancel(id);
        setLoadingChannelIds((items) => items.filter((item) => item !== id));
    };

    const applyBeefConnection = async (summary: BeefAPIConnectionSummary, previousState = beefConnection?.state) => {
        setBeefConnection(summary);
        const retry = catalogSync.current?.state === summary.state ? catalogSync.current : null;
        if (appliedConnectionState.current === summary.state && !retry) return;
        appliedConnectionState.current = summary.state;
        if (!retry && !shouldRefreshBeefAPICatalog(previousState, summary.state)) {
            catalogSync.current = null;
            setCatalogSyncFailed(false);
            return;
        }
        const intent = retry || { state: summary.state, selection: useConfigStore.getState().config.assistantModel, adopt: summary.state === "connected" && Boolean(previousState && previousState !== "connected") };
        catalogSync.current = intent;
        try {
            const result = await getLocalModelConfig();
            if (catalogSync.current !== intent) return;
            const current = useConfigStore.getState().config;
            replaceConfig(
                localWorkspaceConfig(
                    normalizeConfigSnapshot({
                        config: mergeManagedBeefAPICatalog(current, result.config, intent.adopt && current.assistantModel === intent.selection),
                    }).config,
                ),
            );
            catalogSync.current = null;
            setCatalogSyncFailed(false);
        } catch {
            if (catalogSync.current === intent) setCatalogSyncFailed(true);
            // Keep the connection status even if the catalog refresh fails.
        }
    };

    useEffect(() => {
        let cancelled = false;
        void getBeefAPIConnection()
            .then((summary) => {
                if (!cancelled) void applyBeefConnection(summary, undefined);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (beefConnection?.state !== "pending" && beefConnection?.state !== "connecting") return;
        let active = true;
        const timer = window.setInterval(() => {
            void getBeefAPIConnection()
                .then((summary) => {
                    if (active) void applyBeefConnection(summary, beefConnection?.state);
                })
                .catch(() => undefined);
        }, 2000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [beefConnection?.state]);

    const runBeefAction = async (action: () => Promise<BeefAPIConnectionSummary>, fallback: string) => {
        setBeefBusy(true);
        const previousConnection = beefConnection;
        const previousState = beefConnection?.state;
        try {
            const summary = await action();
            await applyBeefConnection(summary, previousState);
        } catch (error) {
            try {
                await applyBeefConnection(await getBeefAPIConnection(), previousState);
            } catch {
                setBeefConnection(previousConnection);
            }
            message.error(error instanceof Error ? error.message : fallback);
        } finally {
            setBeefBusy(false);
        }
    };
    const beginBeefConnection = () => {
        setBeefConnection({ state: "connecting", hasCredential: beefConnection?.hasCredential || false });
        return startBeefAPIConnection();
    };
    const retryBeefConnection = async () => {
        const state = beefConnection?.state;
        if (state === "expired" || state === "revoked" || state === "rejected") {
            await disconnectBeefAPIConnection();
        }
        return beginBeefConnection();
    };
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const runningHubReady = Boolean(config.runningHub.enabled && config.runningHub.baseUrl.trim() && config.runningHub.apiKey.trim() && config.runningHub.workflowId.trim());
    const modelsInView = (channel: ModelChannel) =>
        modelsForUsage(channel, usage).filter((model) => !query.trim() || [channel.name, channel.baseUrl, model, channel.modelProfiles?.find((profile) => profile.model === model)?.displayName].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
    const visibleChannels = userChannels.filter((channel) => modelsInView(channel).length || (usage === "all" && !channel.models.length && (!query.trim() || channel.name.toLowerCase().includes(query.trim().toLowerCase()))));

    const updateChannels = (channels: ModelChannel[], baseConfig = config) => {
        replaceConfig(withChannels(baseConfig, channels));
    };

    const addChannel = () => {
        setModelFocus(undefined);
        setServiceEditor(null);
    };

    const saveService = async (channel: ModelChannel, successMessage = "模型服务已保存，可在创作页选择模型") => {
        cancelCatalog(channel.id);
        const latest = useConfigStore.getState().config;
        const channels = latest.channels.some((item) => item.id === channel.id) ? latest.channels.map((item) => (item.id === channel.id ? channel : item)) : [...latest.channels, channel];
        updateChannels(channels, latest);
        await flushModelConfig();
        const saved = getModelConfigPersistenceState();
        if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "模型服务尚未保存，请重试");
        message.success(successMessage);
    };

    const deleteChannel = async (id: string) => {
        if (deleting.current.has(id)) return;
        const latest = useConfigStore.getState().config;
        const channel = latest.channels.find((item) => item.id === id);
        if (channel && (channel.scope === "system" || isBuiltinBeefAPIChannel(channel))) {
            message.warning("系统渠道由管理员维护");
            return;
        }
        deleting.current.add(id);
        cancelCatalog(id);
        const next = withChannels(
            latest,
            latest.channels.filter((item) => item.id !== id),
        );
        replaceConfig(next);
        try {
            await commitModelConfig(next);
            await flushModelConfig();
            const saved = getModelConfigPersistenceState();
            if (saved.status === "error" || saved.dirty) throw new Error(saved.error || "删除尚未保存");
            setDeleteFailures((items) => {
                const next = { ...items };
                delete next[id];
                return next;
            });
            recordChannelDelete({ scope: channel?.scope, before: latest.channels.length, after: next.channels.length });
            message.success("渠道已删除并保存");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "保存失败";
            setDeleteFailures((items) => ({ ...items, [id]: `${channel?.name || "渠道"}删除尚未保存：${detail}。请重试，重新加载可能恢复原渠道。` }));
        } finally {
            deleting.current.delete(id);
        }
    };

    const setChannelLoading = (id: string, loading: boolean) => {
        setLoadingChannelIds((items) => (loading ? Array.from(new Set([...items, id])) : items.filter((item) => item !== id)));
    };

    const refreshChannelModels = async (channel: ModelChannel) => {
        if (isTopazUpscaleChannel(channel)) return;
        const connectionError = channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null);
        if (connectionError) {
            message.error(`${channel.name || "当前渠道"}：${connectionError}`);
            return;
        }
        setChannelLoading(channel.id, true);
        const request = requests.current.start(channel.id);
        try {
            const result = await fetchChannelModels(channel, true, request.signal);
            if (!requests.current.current(channel.id, request)) return;
            if (!result.models.length) {
                message.warning(`${channel.name || "当前渠道"}未返回模型，已保留现有手工模型`);
                return;
            }
            const latestConfig = useConfigStore.getState().config;
            const latestChannel = latestConfig.channels.find((item) => item.id === channel.id);
            if (!latestChannel) return;
            if (channelConnectionSignature(latestChannel) !== channelConnectionSignature(channel)) {
                message.warning(`${latestChannel.name || "当前渠道"}的连接配置已改变，已忽略旧的拉取结果`);
                return;
            }
            if (localMode && isBuiltinBeefAPIChannel(latestChannel)) {
                const server = await getLocalModelConfig();
                if (!requests.current.current(channel.id, request)) return;
                const current = useConfigStore.getState().config;
                replaceConfig(localWorkspaceConfig(normalizeConfigSnapshot({
                    config: mergeManagedBeefAPICatalog(current, server.config),
                }).config));
            } else {
                updateChannels(
                    latestConfig.channels.map((item) => (item.id === channel.id ? applyFetchedChannelModelCatalog(item, result) : item)),
                    latestConfig,
                );
            }
            await flushModelConfig();
            message.success(`${latestChannel.name || "当前渠道"}模型列表已更新`);
        } catch (error) {
            if (requests.current.current(channel.id, request)) message.error(channelModelFetchErrorMessage(error));
        } finally {
            if (requests.current.current(channel.id, request)) setChannelLoading(channel.id, false);
            requests.current.finish(channel.id, request);
        }
    };

    const refreshAllModels = async () => {
        const catalogChannels = userChannels.filter((channel) => !isTopazUpscaleChannel(channel) && !isNativeComfyChannel(channel));
        const runnable = catalogChannels.filter((channel) => !channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null));
        const skipped = catalogChannels.filter((channel) => channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null));
        if (!runnable.length) {
            const detail = skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null)}`).join("；");
            message.error(detail || (catalogChannels.length ? "没有可拉取的个人模型渠道，请先填写有效 Base URL 和 API Key" : "原生 ComfyUI 渠道不使用模型目录拉取，请在渠道卡片中编辑工作流"));
            return;
        }
        setChannelLoading("all", true);
        const batch = new Map<string, AbortController>();
        try {
            const results = await Promise.all(
                runnable.map(async (channel) => {
                    const request = requests.current.start(channel.id);
                    batch.set(channel.id, request);
                    try {
                        const result = await fetchChannelModels(channel, true, request.signal);
                        if (!requests.current.current(channel.id, request)) return { channel, result: { models: [], catalog: [] }, error: "", cancelled: true };
                        return { channel, result, error: "" };
                    } catch (error) {
                        if (!requests.current.current(channel.id, request)) return { channel, result: { models: [], catalog: [] }, error: "", cancelled: true };
                        return { channel, result: { models: [], catalog: [] }, error: channelModelFetchErrorMessage(error) };
                    }
                }),
            );
            const latestConfig = useConfigStore.getState().config;
            const successful = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && latestChannel && requests.current.current(item.channel.id, batch.get(item.channel.id)!) && channelConnectionSignature(latestChannel) === channelConnectionSignature(item.channel));
            });
            const stale = results.filter((item) => {
                const latestChannel = latestConfig.channels.find((channel) => channel.id === item.channel.id);
                return Boolean(item.result.models.length && (!latestChannel || channelConnectionSignature(latestChannel) !== channelConnectionSignature(item.channel)));
            });
            const failed = results.filter((item) => !item.cancelled && !item.result.models.length);
            if (successful.length) {
                const resultMap = new Map(successful.map((item) => [item.channel.id, item.result] as const));
                const refreshedManagedBeefAPI = localMode && successful.some((item) => isBuiltinBeefAPIChannel(item.channel));
                const server = refreshedManagedBeefAPI ? await getLocalModelConfig() : null;
                const current = useConfigStore.getState().config;
                const nextChannels = current.channels.map((channel) => {
                    if (refreshedManagedBeefAPI && isBuiltinBeefAPIChannel(channel)) return channel;
                    const fetched = resultMap.get(channel.id);
                    return fetched ? applyFetchedChannelModelCatalog(channel, fetched) : channel;
                });
                const updated = withChannels(current, nextChannels);
                replaceConfig(server ? localWorkspaceConfig(normalizeConfigSnapshot({
                    config: mergeManagedBeefAPICatalog(updated, server.config),
                }).config) : updated);
                await flushModelConfig();
                message.success(`已更新 ${successful.length} 个渠道的模型`);
            }
            const warnings = [
                ...failed.map((item) => `${item.channel.name || "未命名渠道"}：${item.error || "未返回模型"}`),
                ...stale.map((item) => `${item.channel.name || "未命名渠道"}：连接配置已改变，已忽略旧结果`),
                ...skipped.map((channel) => `${channel.name || "未命名渠道"}：${channelConnectionError(channel, isBuiltinBeefAPIChannel(channel) ? beefConnection : null)}`),
            ];
            if (warnings.length) message.warning(`${warnings.join("；")}。未更新的渠道已保留原有模型列表`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量读取模型失败，原有模型列表未改动");
        } finally {
            for (const [id, request] of batch) requests.current.finish(id, request);
            setChannelLoading("all", false);
        }
    };

    const manage = (channel: ModelChannel, model?: string) => {
        cancelCatalog(channel.id);
        setModelFocus(model);
        setServiceEditor(channel);
    };
    const changeUsage = (value: ModelUsage) => {
        setUsage(value);
        setExpanded([]);
    };
    const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const next =
            event.key === "ArrowRight"
                ? (index + 1) % MODEL_USAGE_ORDER.length
                : event.key === "ArrowLeft"
                  ? (index + MODEL_USAGE_ORDER.length - 1) % MODEL_USAGE_ORDER.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? MODEL_USAGE_ORDER.length - 1
                      : -1;
        if (next < 0) return;
        event.preventDefault();
        changeUsage(MODEL_USAGE_ORDER[next]);
        document.getElementById("model-usage-" + MODEL_USAGE_ORDER[next])?.focus();
    };
    const toggleService = (channel: ModelChannel, enabled: boolean) => {
        const latest = useConfigStore.getState().config;
        const next = withChannels(
            latest,
            latest.channels.map((item) => (item.id === channel.id ? { ...item, enabled } : item)),
        );
        replaceConfig({ ...next, model: latest.model, imageModel: latest.imageModel, videoModel: latest.videoModel, textModel: latest.textModel, audioModel: latest.audioModel, assistantModel: latest.assistantModel });
    };
    return (
        <div className="model-settings-panel">
            {Object.entries(deleteFailures).map(([id, detail]) => (
                <Alert key={id} type="error" showIcon title={detail} action={<Button onClick={() => void deleteChannel(id)}>重试删除</Button>} />
            ))}
            <header className="model-settings-page-heading">
                <h1>模型配置</h1>
                <Button type="primary" icon={<Plus size={16} />} onClick={addChannel}>
                    添加服务
                </Button>
            </header>
            <div className="model-settings-usage" role="tablist" aria-label="模型用途">
                {MODEL_USAGE_ORDER.map((value, index) => (
                    <button
                        type="button"
                        id={"model-usage-" + value}
                        key={value}
                        role="tab"
                        tabIndex={usage === value ? 0 : -1}
                        aria-selected={usage === value}
                        aria-controls="model-services-panel"
                        onClick={() => changeUsage(value)}
                        onKeyDown={(event) => tabKey(event, index)}
                    >
                        {MODEL_USAGE_LABELS[value]}
                    </button>
                ))}
            </div>
            <section id="model-services-panel" role="tabpanel" aria-labelledby={"model-usage-" + usage}>
                {usage !== "all" && <ModelDefaultGrid config={effectiveConfig} usage={usage} onChange={(key, value) => useConfigStore.getState().updateConfig(key, value)} />}
                <div className="model-settings-list-heading">
                    <h2>
                        已添加的服务 <span>{visibleChannels.length}</span>
                    </h2>
                    <Input aria-label="搜索服务或模型" allowClear prefix={<Search size={15} />} placeholder="搜索服务或模型" value={query} onChange={(event) => setQuery(event.target.value)} />
                </div>
                {visibleChannels.length ? (
                    <div className="model-settings-services">
                        {visibleChannels.map((channel) => {
                            const builtin = isBuiltinBeefAPIChannel(channel),
                                native = isNativeComfyChannel(channel),
                                models = modelsInView(channel);
                            const open = expanded.includes(channel.id) || usage !== "all" || Boolean(query.trim());
                            return (
                                <section key={channel.id} data-onboarding={builtin ? "official-channel" : undefined} aria-label={builtin ? "BeefTV" : channel.name} className={"model-settings-service " + (channel.enabled === false ? "is-disabled" : "")}>
                                    <div className="model-settings-service-row">
                                        <span className="model-settings-provider-mark" aria-hidden="true">
                                            {builtin ? <img src={beefTVAppIcon} alt="" /> : native ? <Workflow size={20} /> : <ModelLogo icon={MODEL_SERVICE_PRESETS.find((preset) => preset.id === servicePresetFor(channel))?.icon} size={22} />}
                                        </span>
                                        <div className="model-settings-service-identity">
                                            <div>
                                                <h3>{builtin ? "BeefTV" : channel.name || "未命名服务"}</h3>
                                                <span>{builtin ? "官方 API" : native ? "ComfyUI" : channelProtocolLabel(channel)}</span>
                                            </div>
                                            <p>{safeServiceHost(channel.baseUrl)}</p>
                                        </div>
                                        <div className="model-settings-service-count">
                                            {models.length ? (
                                                <button
                                                    type="button"
                                                    aria-label={(open ? "收起" : "展开") + channel.name + "的 " + models.length + " 个" + (native ? "工作流" : "模型")}
                                                    aria-expanded={open}
                                                    onClick={() => setExpanded((current) => (current.includes(channel.id) ? current.filter((id) => id !== channel.id) : [...current, channel.id]))}
                                                >
                                                    {models.length} 个{native ? "工作流" : "模型"}
                                                    <ChevronDown size={12} className={open ? "is-expanded" : ""} />
                                                </button>
                                            ) : (
                                                <span>未配置</span>
                                            )}
                                            <small>
                                                {[
                                                    ...new Set(
                                                        models.flatMap((model) => {
                                                            const profile = channel.modelProfiles?.find((profile) => profile.model === model);
                                                            return profile ? [profileUsageLabel(profile)] : [];
                                                        }),
                                                    ),
                                                ].join("、")}
                                            </small>
                                        </div>
                                        <Switch size="small" aria-label={"启用服务 " + channel.name} checked={channel.enabled !== false} disabled={!channel.models.length} onChange={(enabled) => toggleService(channel, enabled)} />
                                        <Button type="text" aria-label={"管理服务 " + channel.name} onClick={() => (builtin ? setExpanded((current) => (current.includes(channel.id) ? current : [...current, channel.id])) : manage(channel))}>
                                            管理
                                        </Button>
                                        {!builtin && (
                                            <Dropdown
                                                trigger={["click"]}
                                                menu={{
                                                    items: [
                                                        ...(!native ? [{ key: "refresh", label: "更新模型目录", disabled: loadingChannelIds.includes(channel.id) }] : []),
                                                        {
                                                            key: "remove",
                                                            danger: true,
                                                            label: (
                                                                <Popconfirm
                                                                    title="移除此服务？"
                                                                    description="关联的模型选择会同时移除。"
                                                                    okText="移除"
                                                                    cancelText="取消"
                                                                    onOpenChange={recordChannelDeleteConfirmOpen}
                                                                    onConfirm={() => deleteChannel(channel.id)}
                                                                >
                                                                    <span className="model-settings-delete-trigger">移除服务</span>
                                                                </Popconfirm>
                                                            ),
                                                        },
                                                    ],
                                                    onClick: ({ key }) => {
                                                        if (key === "refresh") void refreshChannelModels(channel);
                                                    },
                                                }}
                                            >
                                                <Button type="text" aria-label={"更多操作 " + channel.name}>
                                                    ···
                                                </Button>
                                            </Dropdown>
                                        )}
                                    </div>
                                    {open && (
                                        <div className="model-settings-models">
                                            {builtin && (
                                                <div className="model-settings-official-actions">
                                                    <ChannelStatus channel={channel} persistence={persistence} connection={beefConnection} />
                                                    <BeefAPIConnectionActions
                                                        connection={beefConnection}
                                                        busy={beefBusy}
                                                        onConnect={() => void runBeefAction(beginBeefConnection, "无法开始连接")}
                                                        onCancel={() => void runBeefAction(cancelBeefAPIConnection, "无法取消连接")}
                                                        onRetry={() => void runBeefAction(retryBeefConnection, "无法重新连接")}
                                                        onDisconnect={() => void runBeefAction(disconnectBeefAPIConnection, "无法断开连接")}
                                                        onWallet={() => void openBeefAPIWallet().catch((error) => message.error(error.message))}
                                                    />
                                                    {catalogSyncFailed && <Button onClick={() => void runBeefAction(getBeefAPIConnection, "无法更新模型列表")}>重试更新模型列表</Button>}
                                                    <Button size="small" disabled={beefConnection?.state !== "connected"} loading={loadingChannelIds.includes(channel.id)} onClick={() => void refreshChannelModels(channel)}>
                                                        更新模型目录
                                                    </Button>
                                                </div>
                                            )}
                                            {models.map((model) => {
                                                const profile = channel.modelProfiles?.find((profile) => profile.model === model);
                                                const encoded = encodeChannelModel(channel.id, model);
                                                const isDefault = [config.imageModel, config.videoModel, config.textModel, config.audioModel].includes(encoded);
                                                return (
                                                    <div key={model} className="model-settings-model-row">
                                                        <div>
                                                            <strong>{profile?.displayName || model}</strong>
                                                            <small>{profile ? profileUsageLabel(profile) : model}</small>
                                                        </div>
                                                        {isDefault && <span className="model-settings-default-tag">默认</span>}
                                                        {!builtin && (
                                                            <Button type="text" size="small" aria-label={"编辑模型 " + (profile?.displayName || model)} onClick={() => manage(channel, model)}>
                                                                编辑
                                                            </Button>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </section>
                            );
                        })}
                    </div>
                ) : (
                    <div className="model-settings-empty">
                        <Search size={25} />
                        <h3>{query ? "没有匹配的服务或模型" : "还没有" + (usage === "all" ? "" : MODEL_USAGE_LABELS[usage]) + "服务"}</h3>
                        {query ? <Button onClick={() => setQuery("")}>清除搜索</Button> : <Button onClick={addChannel}>添加服务</Button>}
                    </div>
                )}
                {onOpenRunningHub && (
                    <WorkflowChannelEntry icon={<Workflow size={18} />} title="RunningHub" description={runningHubReady ? config.runningHub.workflows.length + " 个工作流" : "未配置"} status="" ready={runningHubReady} onOpen={onOpenRunningHub} />
                )}
                <div className="model-settings-list-footer">
                    <span>{persistence.status === "saving" ? "保存中" : persistence.status === "error" ? persistence.error || "保存失败" : ""}</span>
                    <div>
                        <Dropdown menu={{ items: [{ key: "refresh", label: "更新 API 模型目录" }], onClick: () => void refreshAllModels() }}>
                            <Button size="small" type="text" loading={loadingChannelIds.includes("all")} icon={<RefreshCw size={13} />}>
                                更新目录
                            </Button>
                        </Dropdown>
                        {onOpenDiagnostics && (
                            <Button size="small" type="text" icon={<Bug size={13} />} onClick={onOpenDiagnostics}>
                                问题诊断
                            </Button>
                        )}
                    </div>
                </div>
            </section>
            {serviceEditor !== undefined && <ModelServiceDialog initial={serviceEditor} initialUsage={usage} initialModel={modelFocus} onClose={() => setServiceEditor(undefined)} onSave={saveService} />}
        </div>
    );
}

function safeServiceHost(address: string) {
    try {
        const url = new URL(address);
        return url.host + (url.pathname === "/" ? "" : url.pathname);
    } catch {
        return "未配置地址";
    }
}

export function applyFetchedChannelModelCatalog(channel: ModelChannel, result: ChannelModelFetchResult): ModelChannel {
    const profiles = mergeFetchedChannelModelProfiles(channel, result.catalog);
    if (channel.id === "beefapi") return { ...channel, models: uniqueModels(result.models), modelProfiles: profiles };
    const existing = new Map((channel.modelProfiles || []).map((profile) => [profile.model, profile]));
    // Refresh updates the catalog without silently enabling new models or removing manual ones.
    return {
        ...channel,
        models: channel.models.length ? channel.models : uniqueModels(result.models),
        modelProfiles: profiles.map((profile) => {
            const previous = existing.get(profile.model);
            if (!previous) return profile;
            if (seedancePortraitModel(profile.model)) return { ...previous, videoPricing: profile.videoPricing ?? null };
            return profile.videoPricing ? { ...previous, videoPricing: profile.videoPricing } : previous;
        }).concat((channel.modelProfiles || []).filter((profile) => !profiles.some((item) => item.model === profile.model))
            .map((profile) => seedancePortraitModel(profile.model) ? { ...profile, videoPricing: null } : profile)),
    };
}

function WorkflowChannelEntry({ icon, title, description, status, ready, onOpen }: { icon: ReactNode; title: string; description: string; status: string; ready: boolean; onOpen?: () => void }) {
    return (
        <div className="settings-channel flex min-w-0 items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-[var(--workspace-accent)]" aria-hidden="true">
                    {icon}
                </span>
                <div className="min-w-0">
                    <h4 className="text-sm font-semibold">{title}</h4>
                    <p className="mt-0.5 truncate text-xs text-foreground/55">{description}</p>
                    <span className={`settings-channel-status mt-1.5 ${ready ? "is-ready" : "is-warning"}`}>
                        <i aria-hidden="true" />
                        {status}
                    </span>
                </div>
            </div>
            <Button size="small" onClick={onOpen} disabled={!onOpen}>
                配置
            </Button>
        </div>
    );
}

export function channelValidationError(channel: ModelChannel, connection?: BeefAPIConnectionSummary | null) {
    return channelConnectionError(channel, connection) || validateChannelHeaders(channel.headers) || (!channel.models.length ? "请添加至少一个模型" : "");
}

export function isChannelReady(channel: ModelChannel) {
    return !channelValidationError(channel);
}

export function focusInvalidChannelField(channel: ModelChannel) {
    const baseUrlError = channelConnectionError({ ...channel, apiKey: "valid", secretKey: "valid" });
    const field = baseUrlError ? "base-url" : !channelHasGenerationCredential(channel) && !channelAllowsEmptyAPIKey(channel) ? "api-key" : requiresSecretKey(channel) && !channel.secretKey?.trim() ? "secret-key" : "models";
    requestAnimationFrame(() => {
        const element = document.getElementById(`channel-${channel.id}-${field}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
        element?.focus({ preventScroll: true });
    });
}

function ChannelStatus({ channel, persistence, connection }: { channel: ModelChannel; persistence: ModelConfigPersistenceState; connection?: BeefAPIConnectionSummary | null }) {
    const receipts = useModelConnectionTests((state) => state.receipts);
    const tested = channel.models.map((model) => currentModelConnectionReceipt(receipts, channel, model));
    const passed = tested.filter((result) => result?.success).length;
    const failed = tested.filter((result) => result && !result.success).length;
    const error = channelValidationError(channel, connection);
    const label = modelConfigChannelStatusLabel(channel, persistence, connection);
    const testLabel = failed ? `${failed} 个模型测试失败` : passed ? `${passed}/${channel.models.length} 个模型测试通过` : label;
    return (
        <span className={`settings-channel-status ${error || failed ? "is-warning" : passed || connection?.state === "connected" ? "is-ready" : ""}`}>
            <i aria-hidden="true" />
            {isBuiltinBeefAPIChannel(channel) ? label : error || (persistence.status === "saving" || persistence.status === "error" ? label : testLabel)}
        </span>
    );
}

export function shouldRefreshBeefAPICatalog(previous: string | undefined, next: string) {
    if (next === "connected" && previous !== "connected") return true;
    return next === "disconnected" && Boolean(previous) && previous !== "disconnected";
}

export function mergeManagedBeefAPICatalog(current: AiConfig, server: AiConfig, adoptAuthorizedAssistant = false): AiConfig {
    const serverBeef = server.channels.find((channel) => channel.id === "beefapi");
    let found = false;
    const channels = current.channels.map((channel) => {
        if (channel.id !== "beefapi") return channel;
        found = true;
        if (!serverBeef) {
            return { ...channel, models: [], modelProfiles: [], apiKey: "", secretKey: "", credentialRef: undefined, hasApiKey: false, hasSecretKey: false };
        }
        return {
            ...channel,
            models: [...(serverBeef.models || [])],
            modelProfiles: (serverBeef.modelProfiles || []).map((item) => ({ ...item })),
            apiKey: "",
            secretKey: "",
            credentialRef: serverBeef.credentialRef,
            hasApiKey: serverBeef.hasApiKey,
            hasSecretKey: serverBeef.hasSecretKey,
            baseUrl: serverBeef.baseUrl || channel.baseUrl,
        };
    });
    if (serverBeef && !found) {
        channels.unshift({
            ...serverBeef,
            apiKey: "",
            secretKey: "",
            models: [...(serverBeef.models || [])],
            modelProfiles: (serverBeef.modelProfiles || []).map((item) => ({ ...item })),
        });
    }
    return withChannels(adoptAuthorizedAssistant ? { ...current, assistantModel: server.assistantModel } : current, channels);
}

export function modelConfigChannelStatusLabel(channel: ModelChannel, persistence: ModelConfigPersistenceState, connection?: BeefAPIConnectionSummary | null) {
    if (isBuiltinBeefAPIChannel(channel)) {
        if (connection?.state === "connected") return beefAPIConnectionLabel(connection);
        if (connection?.state && connection.state !== "disconnected") return beefAPIConnectionLabel(connection);
        if (channelHasManagedBeefAPICredential(channel)) return "待确认连接";
        return "未连接";
    }
    if (!channelHasGenerationCredential(channel) && !channelAllowsEmptyAPIKey(channel)) return "待配置";
    if (persistence.status === "saving") return "保存中";
    if (persistence.status === "error") return "保存失败";
    if (persistence.status === "saved") return "已保存 · 尚未测试";
    return "尚未测试";
}

export function BeefAPIConnectionActions({
    connection,
    busy,
    onConnect,
    onCancel,
    onRetry,
    onDisconnect,
    onWallet,
}: {
    connection: BeefAPIConnectionSummary | null;
    busy: boolean;
    onConnect: () => void;
    onCancel: () => void;
    onRetry: () => void;
    onDisconnect: () => void;
    onWallet: () => void;
}) {
    const state = connection?.state || "disconnected";
    const buttonClass = "h-10 sm:h-8";
    if (state === "connecting") {
        return (
            <Button className={buttonClass} size="small" loading disabled>
                正在连接
            </Button>
        );
    }
    if (state === "pending") {
        return (
            <>
                <Button className={buttonClass} size="small" loading={busy} onClick={onCancel}>
                    取消
                </Button>
            </>
        );
    }
    if (state === "connected") {
        return (
            <>
                <Button className={buttonClass} size="small" onClick={onWallet}>
                    打开 BeefTV 账户
                </Button>
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "catalog_failed") {
        return (
            <>
                <Button className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                    重新连接
                </Button>
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "expired" || state === "revoked" || state === "rejected" || state === "store_error" || state === "connection_error" || state === "cancelled") {
        return (
            <Button data-onboarding="official-connect" className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                重新连接
            </Button>
        );
    }
    return (
        <Button data-onboarding="official-connect" className={buttonClass} size="small" type="primary" loading={busy} onClick={onConnect}>
            连接 BeefTV
        </Button>
    );
}

export function modelConfigChannelPresentation(channel: ModelChannel) {
    const builtin = isBuiltinBeefAPIChannel(channel);
    return {
        builtin,
        deletable: !builtin,
        adapterLabel: builtin ? "应用内置适配" : "",
    };
}

export function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const models = modelOptionsFromChannels(channels);
    const imageModels = filterModelsByCapability(models, "image", channels);
    const videoModels = filterModelsByCapability(models, "video", channels);
    const textModels = filterModelsByCapability(models, "text", channels);
    const audioModels = filterModelsByCapability(models, "audio", channels);
    return {
        ...config,
        channels,
        models,
        model: normalizeDefaultModel(config.model, models),
        assistantModel: config.channels.some((channel) => !channels.some((item) => item.id === channel.id) && config.assistantModel?.startsWith(`${channel.id}::`)) ? "" : config.assistantModel,
        mediaReviewModel: config.channels.some((channel) => !channels.some((item) => item.id === channel.id) && config.mediaReviewModel?.startsWith(`${channel.id}::`)) ? "" : config.mediaReviewModel,
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    };
}

function normalizeDefaultModel(value: string, options: string[]) {
    return options.includes(value) ? value : options[0] || "";
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function channelModelFetchErrorMessage(error: unknown) {
    if (getTransportFailureKind(error) === "timeout") return "读取模型目录超时，请检查地址和网络后重试；也可以手动添加模型 ID";
    const detail = error instanceof Error ? error.message : "读取模型失败";
    if (detail.includes("不允许访问本机") || detail.includes("不允许访问保留地址")) return `${detail}；可信私网服务需由部署管理员配置 CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS`;
    return `${detail}；也可以直接在模型列表中手动输入模型名`;
}

function channelConnectionMode(channel: ModelChannel): UserChannelConnection {
    return channel.apiFormat === "gemini" ? "gemini" : "openai";
}

function channelConnectionError(channel: ModelChannel, connection?: BeefAPIConnectionSummary | null) {
    const baseUrl = channel.baseUrl.trim();
    if (!baseUrl) return "请填写 Base URL";
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 只支持 HTTP 或 HTTPS";
    } catch {
        return "Base URL 格式不正确";
    }
    if (isBuiltinBeefAPIChannel(channel)) {
        if (connection?.state === "connected" || channelHasManagedBeefAPICredential(channel)) return "";
        return "请先连接 BeefTV";
    }
    if (!channelHasGenerationCredential(channel) && !channelAllowsEmptyAPIKey(channel)) return "请填写 API Key / Access Key";
    if (requiresSecretKey(channel) && !channel.secretKey?.trim()) return "当前协议需要填写 Secret Key";
    return "";
}

function channelConnectionSignature(channel: ModelChannel) {
    return [channel.baseUrl.trim(), channel.referenceAssetOrigin?.trim() || "", channel.apiKey.trim(), channel.secretKey?.trim() || "", channel.apiFormat, JSON.stringify(channel.headers || [])].join("\n");
}

function channelProtocolLabel(channel: ModelChannel) {
    if (isTopazUpscaleChannel(channel)) return "fal · Topaz 专用超分";
    if (isNativeComfyChannel(channel)) return "原生 ComfyUI";
    return channelConnectionMode(channel) === "gemini" ? "Gemini 原生" : "OpenAI 兼容";
}

function isKnownDefaultBaseUrl(value: string) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized) return true;
    return [defaultBaseUrlForApiFormat("openai"), defaultBaseUrlForApiFormat("gemini")].some((candidate) => candidate.replace(/\/+$/, "") === normalized);
}

function requiresSecretKey(channel: ModelChannel) {
    return channel.modelProfiles?.some((item) => item.protocol?.startsWith("volcengine-jimeng-")) === true;
}
