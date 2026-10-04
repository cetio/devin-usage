import * as vscode from "vscode";

import { ProviderStatus } from "./allowance/model";
import { formatAge, formatTimestamp } from "./allowance/format";
import { RefreshInfo } from "./monitor";
import { DisplayContext, describeState } from "./status/display";

const MAX_EVENTS = 50;

export class Diagnostics
{
    private readonly channel = vscode.window.createOutputChannel("Devin Usage");
    private readonly events: string[] = [];

    note(info: RefreshInfo): void
    {
        const parts = [`${formatTimestamp(Date.now())} ${info.provider} refresh: ${info.state} (${info.durationMs}ms)`];
        if (info.cliVersion !== undefined)
            parts.push(`cli ${info.cliVersion}`);
        if (info.message !== undefined)
            parts.push(info.message);
        this.events.push(parts.join(" \u00b7 "));
        if (this.events.length > MAX_EVENTS)
            this.events.shift();
    }

    show(statuses: ProviderStatus[], context: DisplayContext): void
    {
        this.channel.clear();
        this.channel.appendLine(`Devin Usage diagnostics \u2014 ${formatTimestamp(context.now)}`);
        for (const status of statuses)
        {
            this.channel.appendLine("");
            this.channel.appendLine(`${status.label}: ${status.state} (${describeState(status, context)})`);
            this.channel.appendLine(`  CLI: ${status.cliVersion ?? "unknown"}`);
            this.channel.appendLine(`  Last attempt: ${attemptText(status)}`);
            this.channel.appendLine(`  Last success: ${successText(status, context)}`);
            if (status.message !== undefined)
                this.channel.appendLine(`  Message: ${status.message}`);
            for (const pool of status.snapshot?.pools ?? [])
            {
                const windows = pool.windows.map((window) => `${window.label}=${window.usedPercent.toFixed(2)}%`);
                this.channel.appendLine(`  Pool ${pool.id}: ${windows.join(", ")}`);
            }
        }
        if (this.events.length > 0)
        {
            this.channel.appendLine("");
            this.channel.appendLine("Recent refresh events:");
            for (const event of this.events)
                this.channel.appendLine(`  ${event}`);
        }
        this.channel.show();
    }

    dispose(): void
    {
        this.channel.dispose();
    }
}

function attemptText(status: ProviderStatus): string
{
    return status.lastAttemptAt === undefined ? "never" : formatTimestamp(status.lastAttemptAt);
}

function successText(status: ProviderStatus, context: DisplayContext): string
{
    if (status.lastSuccessAt === undefined)
        return "never";
    const age = formatAge(context.now - status.lastSuccessAt);
    return `${formatTimestamp(status.lastSuccessAt)} (${age})`;
}
