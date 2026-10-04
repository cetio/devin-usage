import type { PickerCallbacks, UsagePicker } from "../source/quickpick";
import type { PickAction } from "../source/presentation";
import { ConnectionState, ProviderId, ProviderStatus } from "../source/usage";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

type TestItem = {
    id: string;
    label: string;
    description?: string;
    detail?: string;
    action?: PickAction;
};

type TestButton = { tooltip?: string };

class FakePicker
{
    items: TestItem[] = [];
    activeItems: TestItem[] = [];
    buttons: TestButton[] = [];
    title = "";
    placeholder = "";
    value = "";
    busy = false;
    visible = false;
    disposed = false;
    private acceptHandler: () => void = () => undefined;
    private buttonHandler: (button: TestButton) => void = () => undefined;
    private hideHandler: () => void = () => undefined;

    onDidAccept(handler: () => void): void
    {
        this.acceptHandler = handler;
    }

    onDidTriggerButton(handler: (button: TestButton) => void): void
    {
        this.buttonHandler = handler;
    }

    onDidHide(handler: () => void): void
    {
        this.hideHandler = handler;
    }

    show(): void
    {
        this.visible = true;
    }

    hide(): void
    {
        this.visible = false;
        this.hideHandler();
    }

    dispose(): void
    {
        this.disposed = true;
        this.visible = false;
    }

    accept(item: TestItem): void
    {
        this.activeItems = [item];
        this.acceptHandler();
    }

    press(button: TestButton): void
    {
        this.buttonHandler(button);
    }
}

const instances: FakePicker[] = [];
const BACK: TestButton = { tooltip: "Back" };
const host = {
    QuickPickItemKind: { Default: 0, Separator: -1 },
    QuickInputButtons: { Back: BACK },
    ThemeIcon: class
    {
        constructor(readonly id: string)
        {
        }
    },
    env: { clipboard: { writeText: async () => undefined } },
    window: {
        createQuickPick: () =>
        {
            const ret = new FakePicker();
            instances.push(ret);
            return ret;
        },
        showQuickPick: () =>
        {
            throw new Error("Details must reuse the existing picker.");
        },
        setStatusBarMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
};
const loader = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const load = loader._load;
const replacement = mock.method(loader, "_load", (request: string, parent: unknown, isMain: boolean) =>
{
    return request === "vscode" ? host : load(request, parent, isMain);
});
const Picker = (require("../source/quickpick") as { UsagePicker: typeof UsagePicker }).UsagePicker;
replacement.mock.restore();

function statuses(): ProviderStatus[]
{
    return ["codex", "antigravity"].map((provider) =>
    {
        const poolIds = provider === "codex" ? ["codex"] : ["gemini", "other"];
        return {
            provider: provider as ProviderId,
            label: provider === "codex" ? "Codex" : "Antigravity",
            state: ConnectionState.Ready,
            message: undefined,
            cliVersion: provider === "codex" ? "0.160.0" : "1.2.16",
            snapshot: {
                observedAt: 1000,
                metadata: [],
                pools: poolIds.map((id) =>
                {
                    return {
                        id,
                        label: id,
                        description: undefined,
                        windows: [
                            { id: `${id}-5h`, label: "5h", usedPercent: 3, durationMinutes: 300, resetsAt: 100000 },
                            { id: `${id}-weekly`, label: "Weekly", usedPercent: 16, durationMinutes: 10080,
                                resetsAt: 200000 },
                        ],
                    };
                }),
            },
            refreshing: false,
            lastAttemptAt: 1000,
            lastSuccessAt: 1000,
        };
    });
}

function callbacks(): PickerCallbacks & { refreshProvider: (provider: ProviderId) => Promise<void> }
{
    return {
        refreshAll: async () => undefined,
        refreshProvider: async () => undefined,
        retry: async () => undefined,
        configureCli: () => undefined,
        openSettings: () => undefined,
        showDiagnostics: () => undefined,
        openChatGptUsage: () => undefined,
        setEnabled: () => undefined,
    };
}

function current(): FakePicker
{
    const ret = instances.at(-1);
    assert.ok(ret !== undefined);
    return ret;
}

function windowItem(picker: FakePicker): TestItem
{
    const ret = picker.items.find((item) => item.id.startsWith("window."));
    assert.ok(ret !== undefined);
    return ret;
}

function windowRows(picker: FakePicker): TestItem[]
{
    return picker.items.filter((item) => item.id.startsWith("window."));
}

test("a status click shows only that pool and keeps its scope across refreshes", () =>
{
    const picker = new Picker(callbacks());
    const context = { now: 1000, staleAfterMs: 600000 };
    picker.show(statuses(), context, { provider: "antigravity", poolId: "gemini" });
    const view = current();
    const rows = windowRows(view);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((item) => item.id.startsWith("window.antigravity.gemini.")));
    assert.equal(view.title, "Devin Usage · Antigravity · Gemini");
    view.value = "weekly";
    view.activeItems = [rows[1]!];
    picker.update(statuses(), { ...context, now: 2000 });
    assert.equal(view.value, "weekly");
    assert.equal(view.activeItems[0]?.id, rows[1]?.id);
    assert.equal(windowRows(view).length, 2);
    picker.dispose();
});

test("limit rows are listed but cannot be opened", () =>
{
    const picker = new Picker(callbacks());
    picker.show(statuses(), { now: 1000, staleAfterMs: 600000 }, { provider: "codex", poolId: "codex" });
    const view = current();
    const row = windowItem(view);
    assert.equal(row.action, undefined);
    assert.equal(row.label, "5-hour limit · 3% used");
    assert.equal(windowRows(view).length, 2);
    const pageBefore = view.title;
    view.accept(row);
    assert.equal(view.title, pageBefore);
    assert.equal(view.disposed, false);
    picker.dispose();
});

test("the title refresh button refreshes only the selected provider and shows busy state", async () =>
{
    const actions = callbacks();
    let allCalls = 0;
    const providerCalls: ProviderId[] = [];
    let finish: () => void = () => undefined;
    actions.refreshAll = async () =>
    {
        allCalls += 1;
    };
    actions.refreshProvider = (provider) =>
    {
        providerCalls.push(provider);
        return new Promise<void>((resolve) =>
        {
            finish = resolve;
        });
    };
    const picker = new Picker(actions);
    picker.show(statuses(), { now: 1000, staleAfterMs: 600000 }, { provider: "antigravity", poolId: "gemini" });
    const view = current();
    const refresh = view.buttons.find((button) => button !== BACK);
    assert.ok(refresh !== undefined);
    view.press(refresh);
    assert.equal(allCalls, 0);
    assert.deepEqual(providerCalls, ["antigravity"]);
    assert.equal(view.busy, true);
    view.press(refresh);
    assert.equal(providerCalls.length, 1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view.busy, false);
    picker.dispose();
});

test("settings and connection actions live in a separate menu with back navigation", () =>
{
    const picker = new Picker(callbacks());
    picker.show(statuses(), { now: 1000, staleAfterMs: 600000 }, { provider: "antigravity", poolId: "gemini" });
    const view = current();
    const settings = view.items.find((item) => item.id === "action.manage");
    assert.ok(settings !== undefined);
    assert.equal(view.items.some((item) => item.action?.kind === "configureCli"), false);
    view.accept(settings);
    assert.ok(view.items.some((item) => item.action?.kind === "configureCli"));
    assert.equal(view.items.some((item) => item.action?.kind === "openChatGptUsage"), false);
    view.press(BACK);
    assert.equal(view.title, "Devin Usage · Antigravity · Gemini");
    picker.dispose();
});

test("back from a focused pool shows the all-provider overview", () =>
{
    const picker = new Picker(callbacks());
    picker.show(statuses(), { now: 1000, staleAfterMs: 600000 }, { provider: "codex", poolId: "codex" });
    const view = current();
    view.press(BACK);
    assert.equal(view.title, "Devin Usage");
    assert.equal(windowRows(view).length, 6);
    picker.dispose();
});
