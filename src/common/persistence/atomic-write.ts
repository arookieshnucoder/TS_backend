import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function replaceFile(temporary: string, destination: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, destination); return; }
        catch (error) {
            // Windows readers / scanners can briefly hold the destination. Retrying
            // the rename preserves atomicity; never unlink the existing file.
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
            await delay(10 * 2 ** attempt);
        }
    }
}

/** Replace a file only after its complete contents are written beside the destination. */
export async function atomicWriteFile(destination: string, content: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    // Exclusive creation establishes ownership before any cleanup is permitted.
    const handle = await open(temporary, "wx", 0o600);
    try {
        try { await handle.writeFile(content, "utf8"); }
        finally { await handle.close(); }
        await replaceFile(temporary, destination);
    } catch (error) {
        // Remove only this operation's temporary file; preserve the original error.
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}
