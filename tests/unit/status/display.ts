import { statusDisplay } from "../../../source/status/display";
import { ConnectionState, ProviderStatus } from "../../../source/allowance/model";
import {
    testDisplayPool,
    testPool,
    testSnapshot,
    testStatus,
    testWindow,
    TEST_CONTEXT,
    TEST_NOW,
} from "../../support";

import assert from "node:assert/strict";
import { test } from "node:test";

const CODEX_POOL = testDisplayPool("codex");
const OTHER_POOL = testDisplayPool("other");

test("a ready status shows only the pool label", () =>
{
    const display = statusDisplay(testStatus(), CODEX_POOL, TEST_CONTEXT);
    assert.equal(display.visible, true);
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.accessibility.includes("16% used in the Weekly window"));
});

test("loading, unavailable, and disabled statuses stay honest", () =>
{
    const loading = statusDisplay(testStatus({
        state: ConnectionState.Loading,
        snapshot: undefined,
        refreshing: true,
        lastSuccessAt: undefined,
    }), CODEX_POOL, TEST_CONTEXT);
    assert.equal(loading.text, "Codex");

    const unavailable = statusDisplay(testStatus({
        state: ConnectionState.MissingCli,
        snapshot: undefined,
        refreshing: false,
        message: "The codex CLI was not found.",
    }), CODEX_POOL, TEST_CONTEXT);
    assert.equal(unavailable.text, "Codex");
    assert.ok(unavailable.tooltip.includes("CLI not found"));

    const disabled = statusDisplay(testStatus({ state: ConnectionState.Disabled }), CODEX_POOL, TEST_CONTEXT);
    assert.equal(disabled.visible, false);
});

test("stale values stay labelled and keep their tone", () =>
{
    const display = statusDisplay(
        testStatus({ state: ConnectionState.Stale, message: "offline" }),
        CODEX_POOL,
        TEST_CONTEXT,
    );
    assert.equal(display.text, "Codex");
    assert.equal(display.tone, "normal");
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
    assert.ok(display.accessibility.includes("stale"));
});

test("usage tones escalate at the warning and error thresholds", () =>
{
    const warning = statusDisplay(testStatus({ snapshot: testSnapshot(90) }), CODEX_POOL, TEST_CONTEXT);
    const error = statusDisplay(testStatus({ snapshot: testSnapshot(100) }), CODEX_POOL, TEST_CONTEXT);
    assert.equal(warning.tone, "warning");
    assert.equal(error.tone, "error");
});

test("hovers summarise every window in one line", () =>
{
    const display = statusDisplay(testStatus(), CODEX_POOL, TEST_CONTEXT);
    assert.equal(display.tooltip, "5h: 3% quota used · Weekly: 16% quota used");
});

test("stale hovers keep the summary and explain the staleness", () =>
{
    const display = statusDisplay(
        testStatus({ state: ConnectionState.Stale, message: "offline" }),
        CODEX_POOL,
        TEST_CONTEXT,
    );
    assert.ok(display.tooltip.startsWith("5h: 3% quota used · Weekly: 16% quota used"));
    assert.ok(display.tooltip.includes("Last known values"));
    assert.ok(display.tooltip.includes("offline"));
});

test("provider text is escaped inside hover markdown", () =>
{
    const hostile = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("codex:primary", "5h | `x` $(zap)", 12, 300)])],
            metadata: [{ label: "Plan | tier", value: "**plus**" }],
        },
    });
    const display = statusDisplay(hostile, CODEX_POOL, TEST_CONTEXT);
    assert.equal(display.tooltip, "5h \\| \\`x\\` \\$\\(zap\\): 12% quota used");
});

test("a missing pool shows a placeholder instead of inventing data", () =>
{
    const status: ProviderStatus = testStatus({
        provider: "antigravity",
        label: "Antigravity",
        state: ConnectionState.Partial,
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("gemini", "Gemini Models", [testWindow("gemini-5h", "5h", 1, 300)])],
            metadata: [],
        },
    });
    assert.equal(statusDisplay(status, OTHER_POOL, TEST_CONTEXT).text, "Other (AG)");
    assert.equal(testDisplayPool("gemini").label, "Gemini (AG)");
});
