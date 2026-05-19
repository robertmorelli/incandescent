import { AnalyzerService } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/service.js';
import { ConfigOptions } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/configOptions.js';
import { NullConsole } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/console.js';
import { FullAccessHost } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/fullAccessHost.js';
import { createFromRealFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/realFileSystem.js';
import { createServiceProvider } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/serviceProviderExtensions.js';
import { UriEx } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/uri/uriUtils.js';
import { PyrightFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/pyrightFileSystem.js';
import type { Analysis } from './defs.ts';
import { PYRIGHT } from './utility.ts';

export type Session = {
    analyze: (sourceText: string) => Analysis;
};

export function create_session(): Session {
    const console = new NullConsole();
    const fs = new PyrightFileSystem(createFromRealFileSystem(undefined, console));
    const sp = createServiceProvider(fs, console);
    const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '/';

    const configOptions = new ConfigOptions(UriEx.file(cwd, sp));
    configOptions.typeshedPath = UriEx.file(`${cwd}/${PYRIGHT.typeshed_path}`, sp);
    configOptions.stubPath = UriEx.file(`${cwd}/${PYRIGHT.stub_path}`, sp);
    configOptions.defaultExtraPaths = PYRIGHT.extra_paths.map(p => UriEx.file(`${cwd}/${p}`, sp));
    configOptions.useLibraryCodeForTypes = PYRIGHT.useLibraryCodeForTypes;
    configOptions.indexing = PYRIGHT.indexing;

    const service = new AnalyzerService(PYRIGHT.analyzer_name, sp, {
        console,
        hostFactory: () => new FullAccessHost(sp),
        configOptions,
        shouldRunAnalysis: () => true,
    });
    const uri = UriEx.file(`${cwd}/${PYRIGHT.input_filename}`, sp);
    let version = 0;

    const analyze = (sourceText: string): Analysis => {
        service.setFileOpened(uri, ++version, sourceText);
        let guard = 0;
        while (service.test_program.analyze() && guard++ < PYRIGHT.analyze_loop_guard) {}
        const sourceFile = service.test_program.getBoundSourceFile(uri);
        const parseResults = sourceFile.getParseResults();
        const line_ranges = parseResults.tokenizerOutput.lines._items ?? parseResults.tokenizerOutput.lines;
        return {
            sourceText,
            root: parseResults.parserOutput.parseTree,
            parseResults,
            evaluator: service.test_program.evaluator,
            diagnostics: sourceFile.getDiagnostics?.() ?? [],
            offsetAt: (range: any) => ({
                start: (line_ranges[range.start.line]?.start ?? 0) + range.start.character,
                end: (line_ranges[range.end.line]?.start ?? 0) + range.end.character,
            }),
        };
    };

    return { analyze };
}
