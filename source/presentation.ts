import {
    bindingWindow,
    compareWindows,
    escapeMarkdown,
    formatAge,
    formatCountdown,
    formatPercent,
    formatResetMoment,
    sanitizeLabel,
} from "./format";
import { snapshotIsStale } from "./schedule";
import {
    ConnectionState,
    DisplayPool,
    findPool,
    ProviderId,
    ProviderStatus,
    UsagePool,
    UsageWindow,
} from "./usage";

export type DisplayContext = {
    now: number;
    staleAfterMs: number;
};

export type StatusTone = "normal" | "warning" | "error";

export type StatusDisplay = {
    visible: boolean;
    text: string;
    tone: StatusTone;
    accessibility: string;
    tooltip: string;
};

export type PickerFocus = {
    provider: ProviderId;
    poolId: string;
};

export type PickAction =
    | { kind: "manage" }
    | { kind: "retry"; provider: ProviderId }
    | { kind: "configureCli"; provider: ProviderId }
    | { kind: "openSettings" }
    | { kind: "showDiagnostics" }
    | { kind: "openChatGptUsage" }
    | { kind: "enable"; provider: ProviderId };

export type PickItem = {
    id: string;
    kind: "item" | "separator";
    label: string;
    description: string | undefined;
    detail: string | undefined;
    action: PickAction | undefined;
};

type PickSpec = {
    id: string;
    label: string;
    description?: string | undefined;
    detail?: string | undefined;
    action?: PickAction | undefined;
};

const WARNING_PERCENT = 90;
const ERROR_PERCENT = 100;

export function statusDisplay(
    status: ProviderStatus | undefined,
    displayPool: DisplayPool,
    context: DisplayContext,
): StatusDisplay
{
    const label = displayPool.label;
    if (status === undefined)
    {
        return {
            visible: true,
            text: label,
            tone: "normal",
            accessibility: `${label} usage is starting.`,
            tooltip: `**${escapeMarkdown(label)} usage**\n\nWaiting for the first refresh.`,
        };
    }
    if (status.state === ConnectionState.Disabled)
        return { visible: false, text: "", tone: "normal", accessibility: "", tooltip: "" };
    const pool = findPool(status, displayPool.poolId);
    const window = pool === undefined ? undefined : bindingWindow(pool);
    if (pool === undefined || window === undefined)
    {
        const loading = status.snapshot === undefined && status.refreshing;
        return {
            visible: true,
            text: label,
            tone: "normal",
            accessibility: `${label} usage is ${loading ? "loading" : "unavailable"}.`,
            tooltip: emptyTooltip(status, context),
        };
    }
    const stale = snapshotIsStale(status, context.now, context.staleAfterMs);
    return {
        visible: true,
        text: label,
        tone: toneFor(window.usedPercent),
        accessibility: accessibility(displayPool, window, stale),
        tooltip: tooltip(status, pool, context),
    };
}

export function pickerTitle(statuses: ProviderStatus[], focus?: PickerFocus): string
{
    if (focus === undefined)
        return "Devin Usage";
    const status = statuses.find((candidate) => candidate.provider === focus.provider);
    return `Devin Usage · ${poolHeading(focus.provider, focus.poolId, status?.snapshot?.pools)}`;
}

export function pickerItems(
    statuses: ProviderStatus[],
    context: DisplayContext,
    focus?: PickerFocus,
): PickItem[]
{
    const items: PickItem[] = [];
    for (const status of scopedStatuses(statuses, focus))
    {
        const pools = (status.snapshot?.pools ?? []).filter((pool) =>
        {
            return pool.windows.length > 0 && (focus === undefined || pool.id === focus.poolId);
        });
        if (pools.length === 0 || status.state === ConnectionState.Disabled)
        {
            items.push(separator(`provider.${status.provider}`, focus === undefined ? status.label : "Allowance"));
            items.push(pick({
                id: `status.${status.provider}`,
                label: status.state === ConnectionState.Disabled
                    ? "Monitoring disabled"
                    : status.refreshing ? "Refreshing usage…" : "Usage unavailable",
                description: describeState(status, context),
                detail: status.message ?? (focus === undefined ? undefined : "No usage reported for this pool."),
                action: status.state === ConnectionState.Disabled
                    ? { kind: "enable", provider: status.provider }
                    : { kind: "retry", provider: status.provider },
            }));
            continue;
        }
        for (const pool of pools)
        {
            items.push(separator(
                `pool.${status.provider}.${pool.id}`,
                focus === undefined ? poolHeading(status.provider, pool.id, pools) : "Allowance",
            ));
            const stale = snapshotIsStale(status, context.now, context.staleAfterMs);
            if (stale || status.message !== undefined)
            {
                items.push(pick({
                    id: `status.${status.provider}.${pool.id}`,
                    label: stale ? "$(warning) Last known usage" : "$(info) Connection status",
                    description: updatedText(status, context),
                    detail: status.message,
                }));
            }
            for (const window of [...pool.windows].sort(compareWindows))
            {
                items.push(pick({
                    id: `window.${status.provider}.${pool.id}.${window.id}`,
                    label: `${quotaWindowLabel(window)} · ${formatPercent(window.usedPercent)} used`,
                    detail: resetLine(window, context),
                }));
            }
        }
        const detailsLabel = focus === undefined ? `${status.label} · Details` : "Details";
        items.push(separator(`details.${status.provider}`, detailsLabel));
        for (const entry of status.snapshot?.metadata ?? [])
        {
            items.push(pick({
                id: `metadata.${status.provider}.${entry.label}`,
                label: pickerText(entry.label),
                description: entry.value,
            }));
        }
        items.push(pick({
            id: `updated.${status.provider}`,
            label: "Updated",
            description: updatedText(status, context),
            detail: status.cliVersion === undefined ? status.label : `${status.label} · CLI ${status.cliVersion}`,
        }));
    }
    items.push(separator("actions", "Actions"));
    items.push(pick({
        id: "action.manage",
        label: "$(gear) Settings & connection…",
        detail: "Reconnect, choose a CLI path, or view diagnostics",
        action: { kind: "manage" },
    }));
    return items;
}

export function managementItems(statuses: ProviderStatus[], focus?: PickerFocus): PickItem[]
{
    const items: PickItem[] = [];
    for (const status of scopedStatuses(statuses, focus))
    {
        items.push(separator(`connection.${status.provider}`, status.label));
        items.push(pick({
            id: `action.retry.${status.provider}`,
            label: `$(plug) Reconnect ${status.label}`,
            detail: "Recheck the CLI version and refresh usage",
            action: { kind: "retry", provider: status.provider },
        }));
        items.push(pick({
            id: `action.configure.${status.provider}`,
            label: `$(file) Configure ${status.label} CLI path`,
            action: { kind: "configureCli", provider: status.provider },
        }));
        if (status.provider === "codex")
        {
            items.push(pick({
                id: "action.chatgpt",
                label: "$(link-external) Open ChatGPT usage page",
                action: { kind: "openChatGptUsage" },
            }));
        }
    }
    items.push(separator("settings", "Settings"));
    items.push(pick({ id: "action.settings", label: "$(gear) Open settings", action: { kind: "openSettings" } }));
    items.push(pick({
        id: "action.diagnostics",
        label: "$(output) Show diagnostics",
        action: { kind: "showDiagnostics" },
    }));
    return items;
}

export function quotaWindowLabel(window: UsageWindow): string
{
    if (window.durationMinutes === 10080)
        return "Weekly limit";
    if (window.durationMinutes === 1440)
        return "Daily limit";
    if (window.durationMinutes !== undefined && window.durationMinutes % 60 === 0)
        return `${window.durationMinutes / 60}-hour limit`;
    const label = pickerText(window.label);
    return /limit$/i.test(label) ? label : `${label} limit`;
}

function scopedStatuses(statuses: ProviderStatus[], focus: PickerFocus | undefined): ProviderStatus[]
{
    return statuses.filter((status) => focus === undefined || status.provider === focus.provider);
}

function poolHeading(provider: ProviderId, poolId: string, pools: UsagePool[] | undefined): string
{
    if (provider === "codex" && poolId === "codex")
        return "Codex";
    if (provider === "antigravity" && poolId === "gemini")
        return "Antigravity · Gemini";
    if (provider === "antigravity" && poolId === "other")
        return "Antigravity · Other Models";
    const label = pools?.find((pool) => pool.id === poolId)?.label ?? poolId;
    return `${provider === "codex" ? "Codex" : "Antigravity"} · ${pickerText(label)}`;
}

export function describeState(status: ProviderStatus, context: DisplayContext): string
{
    const age = status.lastSuccessAt === undefined ? undefined : formatAge(context.now - status.lastSuccessAt);
    switch (status.state)
    {
        case ConnectionState.Ready:
            return age === undefined ? "ready" : `updated ${age}`;
        case ConnectionState.Partial:
            return age === undefined ? "partially ready" : `partially updated ${age}`;
        case ConnectionState.Stale:
            return age === undefined ? "stale" : `stale, updated ${age}`;
        case ConnectionState.Loading:
            return "loading";
        case ConnectionState.MissingCli:
            return "CLI not found";
        case ConnectionState.AuthRequired:
            return "sign-in required";
        case ConnectionState.Unsupported:
            return "unsupported";
        case ConnectionState.Disabled:
            return "disabled";
        default:
            return "unavailable";
    }
}

function tooltip(status: ProviderStatus, pool: UsagePool, context: DisplayContext): string
{
    const blocks = [summaryLine(pool)];
    if (snapshotIsStale(status, context.now, context.staleAfterMs))
    {
        const age = status.lastSuccessAt === undefined ? undefined : formatAge(context.now - status.lastSuccessAt);
        blocks.push(age === undefined ? "_Last known values._" : `_Last known values \u2014 updated ${age}._`);
    }
    if (status.message !== undefined)
        blocks.push(escapeMarkdown(sanitizeLabel(status.message)));
    return blocks.join("\n\n");
}

function emptyTooltip(status: ProviderStatus, context: DisplayContext): string
{
    const blocks = [`**${escapeMarkdown(status.label)} usage**`, `_${capitalize(describeState(status, context))}._`];
    if (status.message !== undefined)
        blocks.push(escapeMarkdown(sanitizeLabel(status.message)));
    return blocks.join("\n\n");
}

function summaryLine(pool: UsagePool): string
{
    const parts = pool.windows.map((window) =>
    {
        const label = escapeMarkdown(sanitizeLabel(window.label));
        return `${label}: ${formatPercent(window.usedPercent)} quota used`;
    });
    return parts.join(" \u00b7 ");
}

function resetLine(window: UsageWindow, context: DisplayContext): string
{
    if (window.resetsAt === undefined)
        return "Reset time unknown";
    if (window.resetsAt <= context.now)
        return "Awaiting refresh";
    return `Resets in ${formatCountdown(window.resetsAt - context.now)} · ${formatResetMoment(window.resetsAt)}`;
}

function updatedText(status: ProviderStatus, context: DisplayContext): string
{
    if (status.lastSuccessAt === undefined)
        return "never";
    const age = formatAge(context.now - status.lastSuccessAt);
    return snapshotIsStale(status, context.now, context.staleAfterMs) ? `${age} (stale)` : age;
}

function accessibility(displayPool: DisplayPool, window: UsageWindow, stale: boolean): string
{
    const label = sanitizeLabel(window.label);
    const parts = [`${displayPool.label} usage: ${formatPercent(window.usedPercent)} used in the ${label} window.`];
    if (stale)
        parts.push("Values are stale.");
    parts.push("Press Enter for details and actions.");
    return parts.join(" ");
}

function toneFor(usedPercent: number): StatusTone
{
    if (usedPercent >= ERROR_PERCENT)
        return "error";
    return usedPercent >= WARNING_PERCENT ? "warning" : "normal";
}

function pickerText(text: string): string
{
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\$\(/g, "$ (");
}

function separator(id: string, label: string): PickItem
{
    return {
        id,
        kind: "separator",
        label: pickerText(label),
        description: undefined,
        detail: undefined,
        action: undefined,
    };
}

function pick(spec: PickSpec): PickItem
{
    return {
        id: spec.id,
        kind: "item",
        label: spec.label,
        description: spec.description === undefined ? undefined : pickerText(spec.description),
        detail: spec.detail === undefined ? undefined : pickerText(spec.detail),
        action: spec.action ?? undefined,
    };
}

function capitalize(text: string): string
{
    if (text.length === 0)
        return text;
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
