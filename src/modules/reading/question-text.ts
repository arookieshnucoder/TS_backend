/** Public pages and pasted questions share one option parser, including compact `A．富足B．增加` layouts. */
export function readingOptionParts(text: string): { question: string; options: string[] } {
    const markers = [...text.matchAll(/(?<![A-Za-z])([A-F])[.．、。]\s*/g)];
    if (markers.length < 2) return { question: text, options: [] };
    if (markers.length > 6 || markers.some((marker, index) => marker[1] !== "ABCDEF"[index])) throw new Error("Reading options must be ordered A..F");
    return { question: text.slice(0, markers[0]!.index).trim(),
        options: markers.map((marker, index) => text.slice(marker.index! + marker[0].length, markers[index + 1]?.index).trim()) };
}
