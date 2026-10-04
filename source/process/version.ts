export type Version = {
    major: number;
    minor: number;
    patch: number;
};

export function parseVersion(text: string): Version | undefined
{
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (match === null)
        return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch))
        return undefined;
    return { major, minor, patch };
}

export function versionAtLeast(version: Version, minimum: Version): boolean
{
    if (version.major !== minimum.major)
        return version.major > minimum.major;
    if (version.minor !== minimum.minor)
        return version.minor > minimum.minor;
    return version.patch >= minimum.patch;
}

export function formatVersion(version: Version): string
{
    return `${version.major}.${version.minor}.${version.patch}`;
}
