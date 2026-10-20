/** Shutdown depends on closeable resources, rather than concrete stores or clients. */
interface Closeable { close(): Promise<void>; }
interface ApplicationResources {
    mcp: Closeable;
    auth?: { store: Closeable };
    solutionSkills?: { store: Closeable };
    workflows?: Closeable;
}

export async function closeApplicationResources(dependencies: ApplicationResources, background?: Closeable) {
    // Learning must finish cancellation/rollback before its database pool closes.
    const backgroundResults = await Promise.allSettled([Promise.resolve().then(() => background?.close())]);
    const resources = [dependencies.mcp, dependencies.auth?.store, dependencies.solutionSkills?.store, dependencies.workflows];
    const results = await Promise.allSettled(resources.map(resource => Promise.resolve().then(() => resource?.close())));
    return [...backgroundResults, ...results];
}
