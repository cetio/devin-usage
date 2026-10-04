import { PickItem, managementItems, pickerItems, pickerTitle } from "../../../source/picker/model";
import { ConnectionState } from "../../../source/allowance/model";
import { testAntigravityStatus, testPool, testStatus, testWindow, TEST_CONTEXT, TEST_NOW } from "../../support";

import assert from "node:assert/strict";
import { test } from "node:test";

test("usage rows show comparable limits while connection actions stay out of the main menu", () =>
{
    const items = pickerItems([testStatus()], TEST_CONTEXT);
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
    const items = managementItems([testStatus()]);
    const headings = items.filter((item) => item.kind === "separator").map((item) => item.label);
    assert.deepEqual(headings, ["Codex", "Settings"]);
    assert.ok(items.some((item) => item.action?.kind === "retry"));
    assert.ok(items.some((item) => item.action?.kind === "configureCli"));
    assert.ok(items.some((item) => item.action?.kind === "openChatGptUsage"));
    assert.ok(items.some((item) => item.action?.kind === "showDiagnostics"));
});

test("picker items guide recovery for disabled and empty providers", () =>
{
    const disabled = pickerItems([testStatus({ state: ConnectionState.Disabled, snapshot: undefined })], TEST_CONTEXT);
    const enable = disabled.find((item) => item.action?.kind === "enable");
    assert.ok(enable !== undefined);
    assert.equal(enable.label, "Monitoring disabled");

    const signedOut = testStatus({ state: ConnectionState.AuthRequired, snapshot: undefined, message: "sign in" });
    const retry = pickerItems([signedOut], TEST_CONTEXT).find((item) => item.action?.kind === "retry");
    assert.ok(retry !== undefined);
    assert.equal(retry.label, "Usage unavailable");
    assert.equal(retry.description, "sign-in required");
    assert.equal(retry.detail, "sign in");
});

test("limit rows cannot be opened", () =>
{
    const items = pickerItems([testStatus()], TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    const rows = items.filter((item) => item.id.startsWith("window."));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.action === undefined));
    assert.deepEqual(rows.map((row) => row.label), ["5-hour limit · 3% used", "Weekly limit · 16% used"]);
    assert.ok(rows.every((row) => row.detail?.startsWith("Resets in ")));
});

test("Codex and Gemini use the same labels, order, values and reset layout", () =>
{
    const statuses = [testStatus(), testAntigravityStatus()];
    const codex = pickerItems(statuses, TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    const gemini = pickerItems(statuses, TEST_CONTEXT, { provider: "antigravity", poolId: "gemini" });
    const rows = (items: PickItem[]) => items.filter((item) => item.id.startsWith("window.")).map((item) =>
    {
        return { label: item.label, description: item.description, detail: item.detail };
    });
    assert.deepEqual(rows(codex), rows(gemini));
    assert.deepEqual(rows(gemini).map((row) => row.label), ["5-hour limit · 3% used", "Weekly limit · 16% used"]);
    for (const items of [codex, gemini])
        assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
            "Allowance", "Details", "Actions",
        ]);
    assert.equal(gemini.some((item) => item.id === "metadata.codex.Plan"), false);
    assert.equal(pickerTitle(statuses), "Devin Usage");
    assert.equal(pickerTitle(statuses, { provider: "codex", poolId: "codex" }), "Devin Usage · Codex");
    const title = pickerTitle(statuses, { provider: "antigravity", poolId: "gemini" });
    assert.equal(title, "Devin Usage · Antigravity · Gemini");
});

test("the overview groups pools without duplicating provider headings", () =>
{
    const items = pickerItems([testStatus(), testAntigravityStatus()], TEST_CONTEXT);
    assert.deepEqual(items.filter((item) => item.kind === "separator").map((item) => item.label), [
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
    const current = testAntigravityStatus();
    if (current.snapshot === undefined)
        throw new Error("Missing Antigravity fixture snapshot");
    current.snapshot.pools = current.snapshot.pools.filter((pool) => pool.id === "gemini");
    const items = pickerItems([testStatus(), current], TEST_CONTEXT, { provider: "antigravity", poolId: "other" });
    assert.equal(items.some((item) => item.id.startsWith("window.")), false);
    assert.equal(items.find((item) => item.id === "status.antigravity")?.label, "Usage unavailable");
});

test("stale limits stay explicit without changing reported values", () =>
{
    const current = testStatus({ state: ConnectionState.Stale, message: "Offline" });
    const items = pickerItems([current], TEST_CONTEXT, { provider: "codex", poolId: "codex" });
    assert.ok(items.some((item) => item.label === "$(warning) Last known usage" && item.detail === "Offline"));
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "5-hour limit · 3% used");
});

test("unknown windows and missing reset times remain readable", () =>
{
    const current = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("custom", "Burst", 0)])],
            metadata: [],
        },
    });
    const row = pickerItems([current], TEST_CONTEXT).find((item) => item.id.startsWith("window."));
    assert.equal(row?.label, "Burst limit · 0% used");
    assert.equal(row?.description, undefined);
    assert.equal(row?.detail, "Reset time unknown");
});

test("provider metadata cannot render native icons in the picker", () =>
{
    const current = testStatus({
        snapshot: {
            observedAt: TEST_NOW,
            pools: [testPool("codex", "Codex", [testWindow("custom", "$(zap)\nBurst", 0)])],
            metadata: [{ label: "Plan", value: "$(warning) Plus" }],
        },
    });
    const items = pickerItems([current], TEST_CONTEXT);
    assert.equal(items.find((item) => item.id === "metadata.codex.Plan")?.description, "$ (warning) Plus");
    assert.equal(items.find((item) => item.id.startsWith("window."))?.label, "$ (zap) Burst limit · 0% used");
});
