import assert from "node:assert/strict";
import { test } from "node:test";

import {
    backoffDelayMs,
    earliestResetAt,
    isHealthy,
    isStale,
    isTerminal,
    MAX_BACKOFF_MS,
    snapshotIsStale,
} from "../../../source/allowance/schedule";
import { ConnectionState, ProviderSnapshot, ProviderStatus, UsageWindow } from "../../../source/allowance/model";

function window(id: string, resetsAt: number | undefined): UsageWindow
{
    return { id, label: id, usedPercent: 1, durationMinutes: undefined, resetsAt };
}

function snapshot(windows: UsageWindow[]): ProviderSnapshot
{
    return { observedAt: 0, pools: [{ id: "pool", label: "Pool", description: undefined, windows }], metadata: [] };
}

function status(changes: Partial<ProviderStatus>): ProviderStatus
{
    return {
        provider: "codex",
        label: "Codex",
        state: ConnectionState.Ready,
        message: undefined,
        cliVersion: undefined,
        snapshot: undefined,
        refreshing: false,
        lastAttemptAt: undefined,
        lastSuccessAt: undefined,
        ...changes,
    };
}

test("backoff doubles failures up to the cap and stays off in manual mode", () =>
{
    assert.equal(backoffDelayMs(300000, 0), 300000);
    assert.equal(backoffDelayMs(300000, 1), 600000);
    assert.equal(backoffDelayMs(300000, 2), 1200000);
    assert.equal(backoffDelayMs(300000, 12), MAX_BACKOFF_MS);
    assert.equal(backoffDelayMs(0, 3), 0);
});

test("the earliest reset ignores past and missing timestamps", () =>
{
    assert.equal(earliestResetAt(undefined, 1000), undefined);
    assert.equal(earliestResetAt(snapshot([window("a", undefined)]), 1000), undefined);
    assert.equal(earliestResetAt(snapshot([window("a", 500)]), 1000), undefined);
    assert.equal(earliestResetAt(snapshot([window("a", 9000), window("b", 3000)]), 1000), 3000);
});

test("staleness distinguishes age from failed refreshes", () =>
{
    assert.equal(isStale(undefined, 1000, 100), false);
    assert.equal(isStale(1000, 1050, 100), false);
    assert.equal(isStale(1000, 1200, 100), true);
    assert.equal(isStale(1000, 99999, Number.POSITIVE_INFINITY), false);
    assert.equal(snapshotIsStale(status({ snapshot: snapshot([]) }), 5000, 1000), false);
    assert.equal(snapshotIsStale(status({ snapshot: snapshot([]), lastSuccessAt: 1000 }), 5000, 1000), true);
    assert.equal(snapshotIsStale(status({ snapshot: snapshot([]), state: ConnectionState.Stale }), 5000, 1000), true);
    assert.equal(snapshotIsStale(status({}), 5000, 1000), false);
});

test("terminal states stop automatic retries", () =>
{
    assert.equal(isTerminal(ConnectionState.AuthRequired), true);
    assert.equal(isTerminal(ConnectionState.MissingCli), true);
    assert.equal(isTerminal(ConnectionState.Unsupported), true);
    assert.equal(isTerminal(ConnectionState.Disabled), true);
    assert.equal(isTerminal(ConnectionState.Unavailable), false);
    assert.equal(isTerminal(ConnectionState.Stale), false);
    assert.equal(isHealthy(ConnectionState.Ready), true);
    assert.equal(isHealthy(ConnectionState.Partial), true);
    assert.equal(isHealthy(ConnectionState.Stale), false);
});
