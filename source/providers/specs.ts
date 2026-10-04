import { ProviderAdapter, ProviderId, ProviderInvocation } from "../usage";
import { createAntigravityAdapter } from "./antigravity";
import { createCodexAdapter } from "./codex";

export type ProviderSpec = {
    id: ProviderId;
    label: string;
    command: string;
    readArgs: string[];
    timeoutMs: number;
    create: (invocation: ProviderInvocation, clientVersion: string) => ProviderAdapter;
};

export const PROVIDER_SPECS: ProviderSpec[] = [
    {
        id: "codex",
        label: "Codex",
        command: "codex",
        readArgs: ["app-server", "--stdio"],
        timeoutMs: 30000,
        create: (invocation, clientVersion) => createCodexAdapter(invocation, clientVersion),
    },
    {
        id: "antigravity",
        label: "Antigravity",
        command: "agy",
        readArgs: ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--mode", "plan"],
        timeoutMs: 30000,
        create: (invocation) => createAntigravityAdapter(invocation),
    },
];

export function findSpec(provider: ProviderId): ProviderSpec
{
    const spec = PROVIDER_SPECS.find((candidate) => candidate.id === provider);
    if (spec === undefined)
        throw new Error(`Unknown provider: ${provider}`);
    return spec;
}
