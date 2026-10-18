import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { ToolAccessError, ToolInputError, type RegisteredTool } from "./tool-contracts.js";
import { defineReadOnlyTool, integerParameter, stringParameter } from "./define-tool.js";

const blockedDirectories = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".codex", ".npm-cache", "node_modules", "dist", "build", "coverage", "data"]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json", ".md", ".txt", ".css", ".scss", ".html", ".yml", ".yaml", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".toml", ".xml", ".sql"]);
const maxFileBytes = 1024 * 1024;
const allowedName = (name: string) => !blockedDirectories.has(name.toLowerCase()) && !name.startsWith(".") && !/[. ]$/.test(name) &&
    !/(^|[._-])(secret|secrets|credential|credentials|id_rsa|id_ed25519)([._-]|$)/i.test(name) && !name.toLowerCase().endsWith(".lock");
const readable = (name: string) => allowedName(name) && (extensions.has(extname(name).toLowerCase()) || ["Dockerfile", "LICENSE"].includes(name));

/** 受根目录和排除路径约束的工作区读取器，供文件检索工具使用。 */
export class WorkspaceReader {
    private readonly root: string;
    private exclusions?: Promise<string[]>;
    constructor(root: string, private readonly excludedPaths: string[] = []) { this.root = resolve(root); }
    private within(root: string, path: string): boolean {
        const rel = relative(root, path);
        return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
    }
    private async canonical(path: string): Promise<string> {
        try { return await realpath(path); }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT") || dirname(path) === path) throw error;
            return join(await this.canonical(dirname(path)), basename(path));
        }
    }
    private async excluded(path: string): Promise<boolean> {
        this.exclusions ??= Promise.all(this.excludedPaths.map(excluded => this.canonical(resolve(excluded))));
        return (await this.exclusions).some(excluded => this.within(excluded, path));
    }
    private async path(input: string, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        if (isAbsolute(input) || /^[a-z]:/i.test(input) || /[:\0]/.test(input)) throw new ToolAccessError();
        const parts = input.replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
        if (parts.some(part => part === ".." || !allowedName(part))) throw new ToolAccessError();
        const root = await realpath(this.root);
        let path = root;
        for (const part of parts) {
            path = join(path, part);
            if ((await lstat(path)).isSymbolicLink()) throw new ToolAccessError();
        }
        const resolved = await realpath(path);
        if (!this.within(root, resolved) || await this.excluded(resolved)) throw new ToolAccessError();
        signal?.throwIfAborted();
        return resolved;
    }
    private async text(path: string, signal?: AbortSignal): Promise<string> {
        if (!readable(path.split(sep).at(-1)!)) throw new ToolAccessError();
        const handle = await open(path, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > maxFileBytes) throw new ToolAccessError();
            const buffer = Buffer.alloc(maxFileBytes + 1);
            let count = 0;
            while (count < buffer.length) {
                signal?.throwIfAborted();
                const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
                if (!bytesRead) break;
                count += bytesRead;
            }
            if (count > maxFileBytes || buffer.subarray(0, count).includes(0)) throw new ToolAccessError();
            return buffer.subarray(0, count).toString("utf8");
        } finally { await handle.close(); }
    }
    async list(input: string, signal?: AbortSignal): Promise<string> {
        const path = await this.path(input, signal);
        const entries: string[] = [];
        let scanned = 0, truncated = false;
        for await (const entry of await opendir(path)) {
            signal?.throwIfAborted();
            if (++scanned > 2000 || entries.length >= 200) { truncated = true; break; }
            if (!allowedName(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !readable(entry.name))) continue;
            if (await this.excluded(join(path, entry.name))) continue;
            entries.push(entry.name + (entry.isDirectory() ? "/" : ""));
        }
        return JSON.stringify({ path: input, entries: entries.sort(), truncated });
    }
    async read(input: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<string> {
        const content = await this.text(await this.path(input, signal), signal);
        const lines = content.split(/\r?\n/);
        return JSON.stringify({
            path: input, totalLines: lines.length, startLine, endLine: Math.min(endLine, lines.length),
            content: lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n")
        });
    }
    /** 文件名查找与文本搜索共享遍历；所有入口沿用链接、排除目录和扫描上限检查。 */
    private async *files(input: string, state: { scanned: number; truncated: boolean }, signal?: AbortSignal): AsyncGenerator<{ path: string }> {
        const start = await this.path(input, signal);
        if (!(await lstat(start)).isDirectory()) throw new ToolInputError("path must be a directory");
        const pending = [start];
        const root = await realpath(this.root);
        let entries = 0;
        while (pending.length) {
            const directory = await this.path(relative(root, pending.pop()!).split(sep).join("/") || ".", signal);
            for await (const entry of await opendir(directory)) {
                signal?.throwIfAborted();
                if (++entries > 10000 || state.scanned >= 2000) { state.truncated = true; return; }
                if (!allowedName(entry.name) || entry.isSymbolicLink()) continue;
                const candidate = join(directory, entry.name);
                if (await this.excluded(candidate)) continue;
                if (entry.isDirectory()) { pending.push(candidate); continue; }
                if (!entry.isFile() || !readable(entry.name)) continue;
                state.scanned++;
                yield { path: relative(root, candidate).split(sep).join("/") };
            }
        }
    }
    async find(input: string, pattern: string, signal?: AbortSignal): Promise<string> {
        const glob = pattern.replace(/\\/g, "/");
        if (isAbsolute(glob) || glob.split("/").includes("..") || /[:\0]/.test(glob)) throw new ToolInputError("pattern must be workspace-relative");
        const state = { scanned: 0, truncated: false };
        const matches: string[] = [];
        for await (const file of this.files(input, state, signal)) {
            if (!matchesGlob(file.path, glob)) continue;
            matches.push(file.path);
            if (matches.length >= 100) { state.truncated = true; break; }
        }
        return JSON.stringify({ path: input, pattern, matches: matches.sort(), scannedFiles: state.scanned, truncated: state.truncated });
    }
    async search(input: string, query: string, signal?: AbortSignal): Promise<string> {
        const matches: { path: string; line: number; text: string }[] = [];
        const state = { scanned: 0, truncated: false };
        const lowerQuery = query.toLowerCase();
        let bytes = 0;
        search: for await (const file of this.files(input, state, signal)) {
            if (bytes >= 8 * maxFileBytes) { state.truncated = true; break; }
            try {
                const text = await this.text(await this.path(file.path, signal), signal);
                bytes += Buffer.byteLength(text);
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i]!.toLowerCase().includes(lowerQuery)) {
                        matches.push({ path: file.path, line: i + 1, text: lines[i]!.slice(0, 500) });
                        if (matches.length >= 50) { state.truncated = true; break search; }
                    }
                }
            } catch (error) {
                signal?.throwIfAborted();
                if (!(error instanceof ToolAccessError) && !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            }
        }
        return JSON.stringify({ query, path: input, matches, scannedFiles: state.scanned, truncated: state.truncated });
    }
}

/**
 * 工作区工具的唯一工厂；各工具共享 WorkspaceReader 的访问策略。
 * list_directory：列出工作区中可访问的源文件和目录，最多返回 200 个条目。
 * read_file：读取文本源文件的最多 200 行内容；返回行号以便引用。
 * search_workspace：使用不区分大小写的字面查询搜索源文本；返回路径和行号。扫描有界；如果被截断，请缩小路径范围。
 * @param root 工作区的根目录路径。
 * @param excludedPaths 要排除的路径列表。
 * @returns 已注册的只读工作区工具数组。
 */
export function createWorkspaceTools(root: string, excludedPaths: string[] = []): RegisteredTool[] {
    const reader = new WorkspaceReader(root, excludedPaths);
    const path = stringParameter(500, "Workspace-relative path; use . for the root.");

    return [
        defineReadOnlyTool({
            name: "find_files",
            description: "Find source files by workspace-relative glob, up to 100 paths. Use **/filename.ext to include nested directories, **/*.ts for a type, src/**/agent*.ts for a subtree. Use search_workspace for contents. Narrow path if truncated.",
            parameters: { path, pattern: stringParameter(500, "Glob matched against paths relative to workspace root, even when path narrows the scan.") },
            execute: ({ path, pattern }, signal) => reader.find(path, pattern, signal),
        }),
        defineReadOnlyTool({
            name: "list_directory",
            description: "List accessible source files and directories (up to 200 entries).",
            parameters: { path },
            execute: ({ path }, signal) => reader.list(path, signal)
        }),

        defineReadOnlyTool({
            name: "read_file",
            description: "Read up to 200 lines from a text source file; returns line numbers for citations.",
            parameters: { path, startLine: integerParameter(1), endLine: integerParameter(1) },
            // 单字段类型和边界由参数声明校验，这里只保留行区间之间的业务约束。
            validate({ startLine, endLine }) {
                if (endLine < startLine || endLine - startLine >= 200)
                    throw new ToolInputError("startLine/endLine must specify 1..200 lines, starting at line 1 or later");
            },
            execute: ({ path, startLine, endLine }, signal) => reader.read(path, startLine, endLine, signal)
        }),

        defineReadOnlyTool({
            name: "search_workspace",
            description: "Search source text using a case-insensitive literal query; returns paths and line numbers. Bounded scan; narrow path if truncated.",
            parameters: { query: stringParameter(500), path },
            execute: ({ path, query }, signal) => reader.search(path, query, signal)
        }),
    ];
}
