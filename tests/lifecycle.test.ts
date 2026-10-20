import assert from "node:assert/strict";
import test from "node:test";
import { closeApplicationResources } from "../src/bootstrap/lifecycle.js";

test("shutdown closes all resources after background cancellation even when cleanup fails", async () => {
    const closed: string[] = [];
    let backgroundFinished = false;
    const resource = (name: string, fail = false) => ({
        async close() {
            assert.equal(backgroundFinished, true, "stores must outlive background rollback");
            closed.push(name);
            if (fail) throw new Error(`${name} close failed`);
        },
    });
    const results = await closeApplicationResources({
        mcp: resource("mcp", true), auth: { store: resource("auth", true) },
        solutionSkills: { store: resource("skills") }, workflows: resource("workflows"),
    }, { async close() { await Promise.resolve(); backgroundFinished = true; throw new Error("background close failed"); } });
    assert.deepEqual(closed, ["mcp", "auth", "skills", "workflows"]);
    assert.equal(results.filter(result => result.status === "rejected").length, 3);
});

test("cleanup tolerates optional resources and synchronous close errors", async () => {
    const results = await closeApplicationResources({ mcp: { close() { throw new Error("synchronous failure"); } } });
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(results.find(result => result.status === "rejected")?.reason.message, "synchronous failure");
});
