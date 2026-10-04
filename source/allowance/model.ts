export type ProviderId = "codex" | "antigravity";

export type PoolId = "codex" | "gemini" | "other";

export enum ConnectionState
{
    Loading = "loading",
    Ready = "ready",
    Partial = "partial",
    Stale = "stale",
    MissingCli = "missingCli",
    AuthRequired = "authRequired",
    Unavailable = "unavailable",
    Unsupported = "unsupported",
    Disabled = "disabled",
}

export type UsageWindow = {
    id: string;
    label: string;
    usedPercent: number;
    durationMinutes: number | undefined;
    resetsAt: number | undefined;
};

export type UsagePool = {
    id: string;
    label: string;
    description: string | undefined;
    windows: UsageWindow[];
};

export type MetadataEntry = {
    label: string;
    value: string;
};

export type ProviderSnapshot = {
    observedAt: number;
    pools: UsagePool[];
    metadata: MetadataEntry[];
};

export type ProviderStatus = {
    provider: ProviderId;
    label: string;
    state: ConnectionState;
    message: string | undefined;
    cliVersion: string | undefined;
    snapshot: ProviderSnapshot | undefined;
    refreshing: boolean;
    lastAttemptAt: number | undefined;
    lastSuccessAt: number | undefined;
};

export type DisplayPool = {
    id: PoolId;
    label: string;
    provider: ProviderId;
    poolId: string;
};

export const DISPLAY_POOLS: DisplayPool[] = [
    { id: "codex", label: "Codex", provider: "codex", poolId: "codex" },
    { id: "gemini", label: "Gemini (AG)", provider: "antigravity", poolId: "gemini" },
    { id: "other", label: "Other (AG)", provider: "antigravity", poolId: "other" },
];

export function expectedPoolIds(provider: ProviderId): string[]
{
    return provider === "codex" ? ["codex"] : ["gemini", "other"];
}

export function findPool(status: ProviderStatus, poolId: string): UsagePool | undefined
{
    return status.snapshot?.pools.find((pool) => pool.id === poolId);
}
