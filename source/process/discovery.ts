import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";

export type CliResolution = { path: string } | { error: string };

export type ResolveCliOptions = {
    name: string;
    configuredPath: string;
    workspacePaths: string[];
    environment: NodeJS.ProcessEnv;
    home: string;
};

export function resolveCli(options: ResolveCliOptions): CliResolution
{
    const configured = options.configuredPath.trim();
    if (configured.length > 0)
    {
        if (!isAbsolute(configured))
            return { error: `The configured ${options.name} path must be absolute.` };
        if (!isExecutableFile(configured))
            return { error: `The configured ${options.name} path is not an executable file.` };
        return { path: configured };
    }
    const candidates: string[] = [join(options.home, ".local", "bin", options.name)];
    const entries = (options.environment.PATH ?? "").split(delimiter);
    for (const entry of entries)
    {
        if (entry.length === 0 || !isAbsolute(entry))
            continue;
        if (isInsideAny(entry, options.workspacePaths))
            continue;
        candidates.push(join(entry, options.name));
    }
    for (const candidate of candidates)
    {
        if (isExecutableFile(candidate))
            return { path: candidate };
    }
    return { error: `The ${options.name} CLI was not found. Install it or set an absolute path in settings.` };
}

export function isExecutableFile(path: string): boolean
{
    try
    {
        if (!statSync(path).isFile())
            return false;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function isInsideAny(path: string, parents: string[]): boolean
{
    for (const parent of parents)
    {
        if (parent.length === 0)
            continue;
        const rel = relative(parent, path);
        if (rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel)))
            return true;
    }
    return false;
}
