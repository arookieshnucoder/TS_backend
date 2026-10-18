import type { EnglishCorpus } from "../src/modules/english/contracts.js";
import { englishHash } from "../src/modules/english/corpus.js";
export function englishFixture(): EnglishCorpus {
    const id = "english-fixture";
    return { version: 1, id: "english-test-fixture", subject: "english", targetGrade: 9, scope: "grade9-practice", limitations: ["Synthetic offline fixture"], excluded: [],
        passages: [{ id, title: "The delivery", paragraphs: ["Mia did not return home before delivering the medicine. She promised to help her neighbour.",
            "There were several shops beside the village bridge.", "She delivered the medicine first and only then went home. Her mother was proud of her."],
            source: { kind: "authored", originalId: id, urls: [`urn:tspj:english:${id}`], sha256: englishHash("fixture"), license: "original fixture" } }],
        knowledge: [{ id: `${id}-q1`, passageId: id, number: 1, question: "Which statement is true according to the passage?", options: ["She delivered medicine before returning home.", "She went home first.", "She never delivered the medicine.", "Her mother was angry."],
            answer: "A", type: "single-choice", kind: "reading", category: "detail" },
        { id: `${id}-q2`, passageId: id, number: 2, question: "What does her action show?", options: ["Fear", "Responsibility", "Laziness", "Anger"], answer: "B", type: "single-choice", kind: "reading", category: "inference" }], development: [], test: [] };
}
