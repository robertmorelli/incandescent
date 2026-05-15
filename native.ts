import { decorate_tree } from "./incandescent.ts";

function map_serializer(inp: Map<any, any>): string {
    let result = "{";
    let first = true;
    for (const [key, value] of inp) {
        if (!first) result += ",";
        result += `${JSON.stringify(String(key))}:${JSON.stringify(value)}`;
        first = false;
    }
    result += "}";
    return result;
}

async function main() {
    const input = await Bun.stdin.text() ?? "";
    try {
        const tree = decorate_tree(input);
        const jsonString = map_serializer(tree);
        process.stdout.write(jsonString);
    } catch (e: any) {
        process.stderr.write(e.message);
        process.exit(1);
    }
}

main();