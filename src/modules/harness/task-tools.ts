import { arrayParameter, defineTool, enumParameter, integerParameter, objectParameter, stringParameter } from "./define-tool.js";
import { ToolInputError } from "./tool-contracts.js";

/** 每次运行各有一份计划；替换整个列表是幂等的，但更新有状态，调度器必须顺序执行。 */
export function taskPlanTool() {
    const todo = objectParameter({
        id: integerParameter(1, 1000),
        title: stringParameter(200),
        status: enumParameter(["not-started", "in-progress", "completed"]),
    });
    let current: ReturnType<typeof todo.parse>[] = [];
    return defineTool({
        name: "manage_todo_list",
        description: "Track a complex task's short plan within this run. write replaces the full list; read returns it (pass todos: []). Keep at most one in-progress item. Completing an item records progress, it does not verify the work. Skip for simple questions.",
        readonly: false, idempotent: true,
        parameters: { operation: enumParameter(["read", "write"]), todos: arrayParameter(todo, 12) },
        validate({ operation, todos }) {
            if (operation === "read" && todos.length) throw new ToolInputError("read requires todos: []");
            if (new Set(todos.map(todo => todo.id)).size !== todos.length) throw new ToolInputError("Todo IDs must be unique");
            if (todos.filter(todo => todo.status === "in-progress").length > 1) throw new ToolInputError("At most one todo may be in-progress");
        },
        async execute({ operation, todos }, signal) {
            signal?.throwIfAborted();
            if (operation === "write") current = structuredClone(todos);
            return JSON.stringify({ todos: current, scope: "current-run" });
        },
    });
}
