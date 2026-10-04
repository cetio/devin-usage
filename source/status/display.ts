import {
    bindingWindow,
    escapeMarkdown,
    formatAge,
    formatPercent,
    sanitizeLabel,
} from "../allowance/format";
import { snapshotIsStale } from "../allowance/schedule";
import {
    ConnectionState,
    DisplayPool,
    findPool,
    ProviderStatus,
    UsagePool,
    UsageWindow,
} from "../allowance/model";

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
        blocks.push(age === undefined ? "_Last known values._" : `_Last known values — updated ${age}._`);
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
    return parts.join(" · ");
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

function capitalize(text: string): string
{
    if (text.length === 0)
        return text;
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
