import * as vscode from "vscode";

import { DISPLAY_POOLS, PoolId, ProviderStatus } from "../allowance/model";
import { DisplayContext, statusDisplay } from "./display";

const STATUS_ITEM_IDS: Record<PoolId, string> = {
    codex: "devinUsage.codex",
    gemini: "devinUsage.gemini",
    other: "devinUsage.other",
};

const STATUS_ITEM_PRIORITIES: Record<PoolId, number> = {
    codex: 3,
    gemini: 2,
    other: 2,
};

export class StatusBarView
{
    private readonly items = new Map<PoolId, vscode.StatusBarItem>();
    private alignment: "left" | "right";
    private visibility: Record<PoolId, boolean>;

    constructor(alignment: "left" | "right", visibility: Record<PoolId, boolean>)
    {
        this.alignment = alignment;
        this.visibility = visibility;
        this.create();
    }

    update(statuses: ProviderStatus[], context: DisplayContext): void
    {
        for (const displayPool of DISPLAY_POOLS)
        {
            const item = this.items.get(displayPool.id);
            if (item === undefined)
                continue;
            const status = statuses.find((candidate) => candidate.provider === displayPool.provider);
            const display = statusDisplay(status, displayPool, context);
            if (!display.visible || !this.visibility[displayPool.id])
            {
                item.hide();
                continue;
            }
            item.text = display.text;
            item.tooltip = new vscode.MarkdownString(display.tooltip);
            item.backgroundColor = display.tone === "warning"
                ? new vscode.ThemeColor("statusBarItem.warningBackground")
                : display.tone === "error"
                    ? new vscode.ThemeColor("statusBarItem.errorBackground")
                    : undefined;
            item.accessibilityInformation = { label: display.accessibility };
            item.show();
        }
    }

    setAlignment(alignment: "left" | "right"): void
    {
        if (this.alignment === alignment)
            return;
        this.alignment = alignment;
        this.dispose();
        this.create();
    }

    setVisibility(visibility: Record<PoolId, boolean>): void
    {
        this.visibility = visibility;
    }

    dispose(): void
    {
        for (const item of this.items.values())
            item.dispose();
        this.items.clear();
    }

    private create(): void
    {
        for (const displayPool of DISPLAY_POOLS)
        {
            const item = vscode.window.createStatusBarItem(
                STATUS_ITEM_IDS[displayPool.id],
                this.alignment === "right" ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
                STATUS_ITEM_PRIORITIES[displayPool.id],
            );
            item.name = `${displayPool.label} Usage`;
            item.command = {
                title: "Show Usage",
                command: "devinUsage.showUsage",
                arguments: [{ provider: displayPool.provider, poolId: displayPool.poolId }],
            };
            this.items.set(displayPool.id, item);
        }
    }
}
