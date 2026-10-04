import * as vscode from "vscode";

import { ProviderId, ProviderStatus } from "../allowance/model";
import { DisplayContext } from "../status/display";
import { managementItems, PickAction, PickItem, PickerFocus, pickerItems, pickerTitle } from "./model";

export type PickerCallbacks = {
    refreshAll: () => Promise<void>;
    refreshProvider: (provider: ProviderId) => Promise<void>;
    retry: (provider: ProviderId) => Promise<void>;
    configureCli: (provider: ProviderId) => void;
    openSettings: () => void;
    showDiagnostics: () => void;
    openChatGptUsage: () => void;
    setEnabled: (provider: ProviderId, enabled: boolean) => void;
};

type UsagePickItem = vscode.QuickPickItem & { id: string; action?: PickAction };

type PickerPage = "usage" | "management";

export class UsagePicker
{
    private readonly callbacks: PickerCallbacks;
    private readonly refreshButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("refresh"),
        tooltip: "Refresh usage",
    };
    private picker: vscode.QuickPick<UsagePickItem> | undefined;
    private focus: PickerFocus | undefined;
    private page: PickerPage = "usage";
    private refreshing = false;
    private statuses: ProviderStatus[] = [];
    private context: DisplayContext = { now: Date.now(), staleAfterMs: Number.POSITIVE_INFINITY };

    constructor(callbacks: PickerCallbacks)
    {
        this.callbacks = callbacks;
    }

    show(statuses: ProviderStatus[], context: DisplayContext, focus?: PickerFocus): void
    {
        this.statuses = statuses;
        this.context = context;
        this.focus = focus;
        this.page = "usage";
        const picker = this.ensurePicker();
        picker.value = "";
        this.render();
        picker.show();
    }

    update(statuses: ProviderStatus[], context: DisplayContext): void
    {
        this.statuses = statuses;
        this.context = context;
        this.render();
    }

    dispose(): void
    {
        const picker = this.picker;
        this.picker = undefined;
        picker?.dispose();
    }

    private ensurePicker(): vscode.QuickPick<UsagePickItem>
    {
        if (this.picker !== undefined)
            return this.picker;
        const picker = vscode.window.createQuickPick<UsagePickItem>();
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.onDidTriggerButton((button) =>
        {
            if (button === vscode.QuickInputButtons.Back)
                this.back();
            else
                void this.refresh();
        });
        picker.onDidAccept(() => this.accept(picker));
        picker.onDidHide(() =>
        {
            if (this.picker === picker)
                this.picker = undefined;
            picker.dispose();
        });
        this.picker = picker;
        return picker;
    }

    private render(): void
    {
        const picker = this.picker;
        if (picker === undefined)
            return;
        const management = this.page === "management";
        const title = management
            ? `${pickerTitle(this.statuses, this.focus)} · Settings & connection`
            : pickerTitle(this.statuses, this.focus);
        const placeholder = management
            ? "Choose a connection or settings action"
            : "Filter limits and details";
        const items = management
            ? managementItems(this.statuses, this.focus)
            : pickerItems(this.statuses, this.context, this.focus);
        const activeId = picker.activeItems[0]?.id;
        const mapped = mapItems(items);
        picker.title = title;
        picker.placeholder = placeholder;
        picker.items = mapped;
        const active = mapped.find((item) => item.id === activeId) ?? mapped.find((item) => item.action !== undefined);
        picker.activeItems = active === undefined ? [] : [active];
        const provider = this.focus?.provider;
        picker.busy = this.refreshing || this.statuses.some((status) =>
        {
            return (provider === undefined || status.provider === provider) && status.refreshing;
        });
        const refresh = {
            ...this.refreshButton,
            tooltip: provider === undefined ? "Refresh all usage" : `Refresh ${provider} usage`,
        };
        picker.buttons = this.page === "usage" && this.focus === undefined
            ? [refresh]
            : [vscode.QuickInputButtons.Back, refresh];
    }

    private back(): void
    {
        if (this.page === "usage")
            this.focus = undefined;
        this.page = "usage";
        if (this.picker !== undefined)
            this.picker.value = "";
        this.render();
    }

    private async refresh(provider = this.focus?.provider, reconnect = false): Promise<void>
    {
        if (this.refreshing)
            return;
        this.refreshing = true;
        this.render();
        try
        {
            if (provider === undefined)
                await this.callbacks.refreshAll();
            else if (reconnect)
                await this.callbacks.retry(provider);
            else
                await this.callbacks.refreshProvider(provider);
        }
        catch
        {
            void vscode.window.showErrorMessage("Devin Usage: refresh failed. See diagnostics for connection details.");
        }
        finally
        {
            this.refreshing = false;
            this.render();
        }
    }

    private accept(picker: vscode.QuickPick<UsagePickItem>): void
    {
        const action = picker.activeItems[0]?.action;
        if (action === undefined)
            return;
        switch (action.kind)
        {
            case "manage":
                this.page = "management";
                picker.value = "";
                this.render();
                return;
            case "retry":
                void this.refresh(action.provider, true);
                return;
            case "configureCli":
                picker.hide();
                this.callbacks.configureCli(action.provider);
                return;
            case "openSettings":
                picker.hide();
                this.callbacks.openSettings();
                return;
            case "showDiagnostics":
                picker.hide();
                this.callbacks.showDiagnostics();
                return;
            case "openChatGptUsage":
                picker.hide();
                this.callbacks.openChatGptUsage();
                return;
            case "enable":
                this.callbacks.setEnabled(action.provider, true);
                return;
        }
    }
}

function mapItems(items: PickItem[]): UsagePickItem[]
{
    return items.map((entry) =>
    {
        const ret: UsagePickItem = {
            id: entry.id,
            label: entry.label,
            kind: entry.kind === "separator" ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
        };
        if (entry.description !== undefined)
            ret.description = entry.description;
        if (entry.detail !== undefined)
            ret.detail = entry.detail;
        if (entry.action !== undefined)
            ret.action = entry.action;
        return ret;
    });
}
