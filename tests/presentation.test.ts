import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DisplayContext,
    managementItems,
    PickItem,
    pickerItems,
    pickerTitle,
    statusDisplay,
} from "../source/presentation";
import {
    ConnectionState,
    DISPLAY_POOLS,
    DisplayPool,
    PoolId,
    ProviderSnapshot,
    ProviderStatus,
    UsagePool,
    UsageWindow,
} from "../source/usage";

const NOW = 1000;
const CONTEXT: DisplayContext = { now: NOW, staleAfterMs: 600000 };
const CODEX_POOL = displayPool("codex");
const OTHER_POOL = displayPool("other");

function displayPool(id: PoolId): DisplayPool
{
    const pool = DISPLAY_POOLS.find((candidate) => candidate.id === id);
    if (pool === undefined)
        throw new Error(`Missing display pool: ${id}`);
    return pool;
}

function window(
    id: string,
    label: string,
    usedPercent: number,
    durationMinutes?: number,
    resetsAt?: number,
): UsageWindow
{
    return { id, label, usedPercent, durationMinutes, resetsAt };
}

function pool(id: string, label: string, windows: UsageWindow[], description?: string): UsagePool
{
    return { id, label, description, windows };
}

function snapshotWith(usedPercent: number): ProviderSnapshot
{
    const windows = [window("codex:primary", "5h", usedPercent, 300)];
    return { observedAt: NOW, pools: [pool("codex", "Codex", windows)], metadata: [] };
}

function status(changes: Partial<ProviderStatus> = {}): ProviderStatus
{
    return {
        provider: "codex",
        label: "Codex",
        state: ConnectionState.Ready,
        message: undefined,
        cliVersion: "0.160.0",
        snapshot: {
            observedAt: NOW,
            pools: [pool("codex", "Codex", [
                window("codex:primary", "5h", 3, 300, NOW + 4 * 3600000),
                window("codex:secondary", "Weekly", 16, 10080, NOW + 6 * 86400000 + 6 * 3600000),
            ])],
            metadata: [{ label: "Plan", value: "plus" }],
        },
        refreshing: false,
        lastAttemptAt: NOW,
        lastSuccessAt: NOW - 100,
        ...changes,
    };
}

test("a ready status shows only the pool label", () =>
{
    const display = statusDisplay(status(), CODEX_POOL, CONTEXT);
    assert.equal(display.visible, true);
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.accessibility.includes("16% used in the Weekly window"));
});

test("loading, unavailable, and disabled statuses stay honest", () =>
{
    const loadingStatus = status({
        state: ConnectionState.Loading,
        snapshot: undefined,
        refreshing: true,
        lastSuccessAt: undefined,
    });
    const loading = statusDisplay(loadingStatus, CODEX_POOL, CONTEXT);
    assert.equal(loading.text, "Codex");

    const missingStatus = status({
        state: ConnectionState.MissingCli,
        snapshot: undefined,
        refreshing: false,
        message: "The codex CLI was not found.",
    });
    const unavailable = statusDisplay(missingStatus, CODEX_POOL, CONTEXT);
    assert.equal(unavailable.text, "Codex");
    assert.ok(unavailable.tooltip.includes("CLI not found"));

    const disabled = statusDisplay(status({ state: ConnectionState.Disabled }), CODEX_POOL, CONTEXT);
    assert.equal(disabled.visible, false);
});

test("stale values stay labelled and keep their tone", () =>
{
    const display = statusDisplay(status({ state: ConnectionState.Stale, message: "offline" }), CODEX_POOL, CONTEXT);
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
    assert.ok(display.accessibility.includes("stale"));
});

test("usage tones escalate at the warning and error thresholds", () =>
{
    const warning = statusDisplay(status({ snapshot: snapshotWith(90) }), CODEX_POOL, CONTEXT);
    assert.equal(warning.tone, "warning");

    const error = statusDisplay(status({ snapshot: snapshotWith(100) }), CODEX_POOL, CONTEXT);
    assert.equal(error.tone, "error");
});

test("hovers summarise every window in one line", () =>
{
    const display = statusDisplay(status(), CODEX_POOL, CONTEXT);
    assert.equal(display.tooltip, "5h: 3% quota used \u00b7 Weekly: 16% quota used");
});

test("stale hovers keep the summary and explain the staleness", () =>
{
    const display = statusDisplay(status({ state: ConnectionState.Stale, message: "offline" }), CODEX_POOL, CONTEXT);
    assert.ok(display.tooltip.startsWith("5h: 3% quota used \u00b7 Weekly: 16% quota used"));
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
});

test("provider text is escaped inside hover markdown", () =>
{
    const hostile = status({
        snapshot: {
            observedAt: NOW,
            pools: [pool("codex", "Codex", [window("codex:primary", "5h | `x` $(zap)", 12, 300)])],
            metadata: [{ label: "Plan | tier", value: "**plus**" }],
        },
    });
    const display = statusDisplay(hostile, CODEX_POOL, CONTEXT);
    assert.equal(display.tooltip, "5h \\| \\`x\\` \\$\\(zap\\): 12% quota used");
});

test("a missing pool shows a placeholder instead of inventing data", () =>
{
    const display = statusDisplay(status({
        provider: "antigravity",
        label: "Antigravity",
        state: ConnectionState.Partial,
        snapshot: {
            observedAt: NOW,
            pools: [pool("gemini", "Gemini Models", [window("gemini-5h", "5h", 1, 300)])],
            metadata: [],
        },
    }), OTHER_POOL, CONTEXT);
    assert.equal(display.text, "Other (AG)");
});

test("usage rows show comparable limits while connection actions stay out of the main menu", () =>
{
    const items = pickerItems([status()], CONTEXT);
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("Codex"));
    assert.ok(labels.includes("5-hour limit · 3% used"));
    assert.ok(labels.includes("Weekly limit · 16% used"));
    assert.ok(labels.includes("Plan"));
    assert.ok(labels.includes("Updated"));
    assert.ok(labels.includes("$(gear) Settings & connection…"));
    assert.equal(items.some((item) => item.action?.kind === "configureCli"), false);
    assert.equal(items.some((item) => item.action?.kind === "openChatGptUsage"), false);
    assert.equal(labels.some((label) => label.includes("remaining")), false);

    const windowItem = items.find((item) => item.id === "window.codex.codex.codex:secondary");
    assert.ok(windowItem !== undefined);
    assert.equal(windowItem.label, "Weekly limit · 16% used");
    assert.equal(windowItem.description, undefined);
    assert.equal(windowItem.action, undefined);
    assert.ok(windowItem.detail?.startsWith("Resets in 6d 6h · "));

    const updated = items.find((item) => item.id === "updated.codex");
    assert.equal(updated?.description, "just now");
    assert.equal(updated?.detail, "Codex · CLI 0.160.0");
});

test("management separates provider connections from general settings", () =>
{
    const items = managementItems([status()]);
    assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
        "Codex", "Settings",
    ]);
    assert.ok(items.some((item) => item.action?.kind === "retry"));
    assert.ok(items.some((item) => item.action?.kind === "configureCli"));
    assert.ok(items.some((item) => item.action?.kind === "openChatGptUsage"));
    assert.ok(items.some((item) => item.action?.kind === "showDiagnostics"));
});

test("picker items guide recovery for disabled and empty providers", () =>
{
    const disabled = pickerItems([status({ state: ConnectionState.Disabled, snapshot: undefined })], CONTEXT);
    const enable = disabled.find((item) => item.action?.kind === "enable");
    assert.ok(enable !== undefined);
    assert.equal(enable.label, "Monitoring disabled");

    const signedOut = status({ state: ConnectionState.AuthRequired, snapshot: undefined, message: "sign in" });
    const empty = pickerItems([signedOut], CONTEXT);
    const retry = empty.find((item) => item.action?.kind === "retry");
    assert.ok(retry !== undefined);
    assert.equal(retry.label, "Usage unavailable");
    assert.equal(retry.description, "sign-in required");
    assert.equal(retry.detail, "sign in");
});

test("limit rows carry no action so they cannot be opened", () =>
{
    const items = pickerItems([status()], CONTEXT, { provider: "codex", poolId: "codex" });
    const rows = items.filter((item) => item.id.startsWith("window."));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.action === undefined));
    assert.deepEqual(rows.map((row) => row.label), ["5-hour limit · 3% used", "Weekly limit · 16% used"]);
    assert.ok(rows.every((row) => row.detail?.startsWith("Resets in ")));
});

function antigravityStatus(changes: Partial<ProviderStatus> = {}): ProviderStatus
{
    return status({
        provider: "antigravity",
        label: "Antigravity",
        cliVersion: "1.2.16",
        snapshot: {
            observedAt: NOW,
            pools: [
                pool("gemini", "Gemini Models", [
                    window("gemini-weekly", "weekly", 16, 10080, NOW + 6 * 86400000 + 6 * 3600000),
                    window("gemini-5h", "5h", 3, 300, NOW + 4 * 3600000),
                ], "Models within this group: Gemini Flash, Gemini Pro"),
                pool("other", "Claude and GPT models", [window("3p-5h", "5h", 0, 300)]),
            ],
            metadata: [],
        },
        ...changes,
    });
}

test("Codex and Gemini use the same labels, window order, percentages and reset layout", () =>
{
    const statuses = [status(), antigravityStatus()];
    const codex = pickerItems(statuses, CONTEXT, { provider: "codex", poolId: "codex" });
    const gemini = pickerItems(statuses, CONTEXT, { provider: "antigravity", poolId: "gemini" });
    const rows = (items: PickItem[]) =>
    {
        return items.filter((item) => item.id.startsWith("window.")).map((item) =>
        {
            return { label: item.label, description: item.description, detail: item.detail };
        });
    };
    assert.deepEqual(rows(codex), rows(gemini));
    assert.deepEqual(rows(gemini).map((row) => row.label), [
        "5-hour limit · 3% used",
        "Weekly limit · 16% used",
    ]);
    for (const items of [codex, gemini])
    {
        assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
            "Allowance", "Details", "Actions",
        ]);
    }
    assert.equal(gemini.some((item) => item.id === "metadata.codex.Plan"), false);
    assert.equal(pickerTitle(statuses), "Devin Usage");
    assert.equal(pickerTitle(statuses, { provider: "codex", poolId: "codex" }), "Devin Usage · Codex");
    const geminiTitle = pickerTitle(statuses, { provider: "antigravity", poolId: "gemini" });
    assert.equal(geminiTitle, "Devin Usage · Antigravity · Gemini");
});

test("the overview groups pools without duplicating provider headings", () =>
{
    const items = pickerItems([status(), antigravityStatus()], CONTEXT);
    const headings = items.filter((item) => item.kind === "separator").map((item) => item.label);
    assert.deepEqual(headings, [
        "Codex",
        "Codex · Details",
        "Antigravity · Gemini",
        "Antigravity · Other Models",
        "Antigravity · Details",
        "Actions",
    ]);
    assert.equal(items.filter((item) => item.id.startsWith("window.")).length, 5);
});

test("a focused missing pool stays empty instead of displaying its sibling", () =>
{
    const current = antigravityStatus();
    assert.ok(current.snapshot !== undefined);
    current.snapshot.pools = current.snapshot.pools.filter((pool) => pool.id === "gemini");
    const items = pickerItems([status(), current], CONTEXT, { provider: "antigravity", poolId: "other" });
    assert.equal(items.some((item) => item.id.startsWith("window.")), false);
    assert.equal(items.find((item) => item.id === "status.antigravity")?.label, "Usage unavailable");
});

test("stale limits stay explicit without changing the reported values", () =>
{
    const current = status({ state: ConnectionState.Stale, message: "Offline" });
    const items = pickerItems([current], CONTEXT, { provider: "codex", poolId: "codex" });
    assert.ok(items.some((item) => item.label === "$(warning) Last known usage" && item.detail === "Offline"));
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "5-hour limit · 3% used");
});

test("unknown windows and missing reset times remain readable", () =>
{
    const current = status({ snapshot: {
        observedAt: NOW,
        pools: [pool("codex", "Codex", [window("custom", "Burst", 0)])],
        metadata: [],
    } });
    const row = pickerItems([current], CONTEXT).find((item) => item.id.startsWith("window."));
    assert.equal(row?.label, "Burst limit · 0% used");
    assert.equal(row?.description, undefined);
    assert.equal(row?.detail, "Reset time unknown");
});

test("provider-supplied metadata cannot render native icons in the picker", () =>
{
    const current = status({ snapshot: {
        observedAt: NOW,
        pools: [pool("codex", "Codex", [window("custom", "$(zap)\nBurst", 0)])],
        metadata: [{ label: "Plan", value: "$(warning) Plus" }],
    } });
    const items = pickerItems([current], CONTEXT);
    assert.equal(items.find((item) => item.id === "metadata.codex.Plan")?.description, "$ (warning) Plus");
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "$ (zap) Burst limit · 0% used");
});
