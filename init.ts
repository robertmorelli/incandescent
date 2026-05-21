import { AnalyzerService } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/service.js';
import { ConfigOptions } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/configOptions.js';
import { NullConsole } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/console.js';
import { FullAccessHost } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/fullAccessHost.js';
import { createFromRealFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/realFileSystem.js';
import { createServiceProvider } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/serviceProviderExtensions.js';
import { UriEx } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/common/uri/uriUtils.js';
import { PyrightFileSystem } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/pyrightFileSystem.js';
import { getIncandescentFacts } from './pyright/packages/pyright-internal/out/packages/pyright-internal/src/analyzer/incandescentFacts.js';
import type { Analysis } from './defs.ts';
import { PYRIGHT } from './utility.ts';
import { TYPESHED_CACHE } from './stubs/typeshed_cache.ts';

class InMemoryStats {
    constructor(private _isFile: boolean, public size: number) {}
    isFile() { return this._isFile; }
    isDirectory() { return !this._isFile; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
    dev = 0;
    ino = 0;
    mode = 0;
    nlink = 0;
    uid = 0;
    gid = 0;
    rdev = 0;
    blksize = 0;
    blocks = 0;
    atimeMs = 0;
    mtimeMs = 0;
    ctimeMs = 0;
    birthtimeMs = 0;
    atime = new Date(0);
    mtime = new Date(0);
    ctime = new Date(0);
    birthtime = new Date(0);
}

class InMemoryDirent {
    parentPath: string = '';
    constructor(public name: string, private _isFile: boolean) {}
    isFile() { return this._isFile; }
    isDirectory() { return !this._isFile; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

const CINDER_STUB_CONTENT = `from typing import Any, Generic, Iterable, Mapping, TypeVar, overload

_T = TypeVar('_T')
_K = TypeVar('_K')
_V = TypeVar('_V')

class _IntPrim(int):
    def __add__(self, other: int, /) -> 'Self': ...
    def __sub__(self, other: int, /) -> 'Self': ...
    def __mul__(self, other: int, /) -> 'Self': ...
    def __floordiv__(self, other: int, /) -> 'Self': ...
    def __mod__(self, other: int, /) -> 'Self': ...
    def __and__(self, other: int, /) -> 'Self': ...
    def __or__(self, other: int, /) -> 'Self': ...
    def __xor__(self, other: int, /) -> 'Self': ...
    def __lshift__(self, other: int, /) -> 'Self': ...
    def __rshift__(self, other: int, /) -> 'Self': ...
    def __neg__(self) -> 'Self': ...
    def __pos__(self) -> 'Self': ...
    def __invert__(self) -> 'Self': ...
    def __lt__(self, other: int, /) -> 'cbool': ...
    def __le__(self, other: int, /) -> 'cbool': ...
    def __gt__(self, other: int, /) -> 'cbool': ...
    def __ge__(self, other: int, /) -> 'cbool': ...
    def __eq__(self, other: object, /) -> 'cbool': ...
    def __ne__(self, other: object, /) -> 'cbool': ...


class _FloatPrim(float):
    def __add__(self, other: float, /) -> 'Self': ...
    def __sub__(self, other: float, /) -> 'Self': ...
    def __mul__(self, other: float, /) -> 'Self': ...
    def __truediv__(self, other: float, /) -> 'Self': ...
    def __mod__(self, other: float, /) -> 'Self': ...
    def __neg__(self) -> 'Self': ...
    def __pos__(self) -> 'Self': ...
    def __lt__(self, other: float, /) -> 'cbool': ...
    def __le__(self, other: float, /) -> 'cbool': ...
    def __gt__(self, other: float, /) -> 'cbool': ...
    def __ge__(self, other: float, /) -> 'cbool': ...
    def __eq__(self, other: object, /) -> 'cbool': ...
    def __ne__(self, other: object, /) -> 'cbool': ...


class int64(_IntPrim): ...
class int32(_IntPrim): ...
class int16(_IntPrim): ...
class int8(_IntPrim): ...
class uint64(_IntPrim): ...
class uint32(_IntPrim): ...
class uint16(_IntPrim): ...
class uint8(_IntPrim): ...
class double(_FloatPrim): ...
class float64(_FloatPrim): ...
class float32(_FloatPrim): ...
class cbool(_IntPrim): ...

class CheckedList(list[_T], Generic[_T]):
    def __init__(self, items: Iterable[_T] = ...) -> None: ...


class CheckedDict(dict[_K, _V], Generic[_K, _V]):
    def __init__(self, items: Mapping[_K, _V] = ...) -> None: ...

chklist = CheckedList
chkdict = CheckedDict

@overload
def cast(typ: type[_T], val: object) -> _T: ...
@overload
def cast(typ: Any, val: object) -> Any: ...

def box(val: object) -> object: ...
def unbox(val: object) -> object: ...
def clen(c: object) -> int: ...

def inline(f: _T) -> _T: ...
def final(f: _T) -> _T: ...
def dynamic_return(f: _T) -> _T: ...

def native(so_path: str): ...

class StaticGeneric(Generic[_T]): ...
`;

class InMemoryOverlayFileSystem extends PyrightFileSystem {
    private getNormalizedPath(uri: any): string {
        const filePath = uri.getFilePath();
        return filePath ? filePath.replace(/\\/g, '/') : '';
    }

    private isInitPath(p: string): boolean {
        return p.endsWith('/stubs/__static__/__init__.pyi');
    }

    private isStaticPath(p: string): boolean {
        return p.endsWith('/stubs/__static__');
    }

    private isStubsPath(p: string): boolean {
        return p.endsWith('/stubs');
    }

    private getTypeshedKey(p: string): string | null {
        const needle = 'pyright/packages/pyright-internal/typeshed-fallback/';
        const idx = p.indexOf(needle);
        if (idx !== -1) {
            return p.substring(idx + needle.length);
        }
        return null;
    }

    private getTypeshedContent(p: string): string | null {
        const key = this.getTypeshedKey(p);
        if (key && key in TYPESHED_CACHE) {
            return TYPESHED_CACHE[key];
        }
        return null;
    }

    override getModulePath(): any {
        return UriEx.file('/');
    }

    override existsSync(uri: any): boolean {
        const p = this.getNormalizedPath(uri);
        if (this.isInitPath(p) || this.isStaticPath(p) || this.isStubsPath(p)) {
            return true;
        }
        const key = this.getTypeshedKey(p);
        if (key !== null) {
            return key in TYPESHED_CACHE;
        }
        return super.existsSync(uri);
    }

    override statSync(uri: any): any {
        const p = this.getNormalizedPath(uri);
        if (this.isInitPath(p)) {
            return new InMemoryStats(true, CINDER_STUB_CONTENT.length);
        }
        if (this.isStaticPath(p) || this.isStubsPath(p)) {
            return new InMemoryStats(false, 0);
        }
        const content = this.getTypeshedContent(p);
        if (content !== null) {
            return new InMemoryStats(true, content.length);
        }
        const key = this.getTypeshedKey(p);
        if (key) {
            const isDir = Object.keys(TYPESHED_CACHE).some(k => k.startsWith(key + '/'));
            if (isDir) {
                return new InMemoryStats(false, 0);
            }
        }
        return super.statSync(uri);
    }

    override readFileSync(uri: any, encoding?: any): any {
        const p = this.getNormalizedPath(uri);
        if (this.isInitPath(p)) {
            if (encoding) {
                return CINDER_STUB_CONTENT;
            }
            return Buffer.from(CINDER_STUB_CONTENT);
        }
        const content = this.getTypeshedContent(p);
        if (content !== null) {
            if (encoding) {
                return content;
            }
            return Buffer.from(content);
        }
        return super.readFileSync(uri, encoding);
    }

    override readdirSync(uri: any): string[] {
        const p = this.getNormalizedPath(uri);
        if (this.isStaticPath(p)) {
            return ['__init__.pyi'];
        }
        if (this.isStubsPath(p)) {
            return ['__static__'];
        }
        const key = this.getTypeshedKey(p);
        if (key !== null) {
            const prefix = key ? key + '/' : '';
            const children = new Set<string>();
            for (const k of Object.keys(TYPESHED_CACHE)) {
                if (k.startsWith(prefix)) {
                    const rel = k.substring(prefix.length);
                    const slashIdx = rel.indexOf('/');
                    if (slashIdx === -1) {
                        children.add(rel);
                    } else {
                        children.add(rel.substring(0, slashIdx));
                    }
                }
            }
            return Array.from(children);
        }
        return super.readdirSync(uri);
    }

    override readdirEntriesSync(uri: any): any[] {
        const p = this.getNormalizedPath(uri);
        if (this.isStaticPath(p)) {
            return [new InMemoryDirent('__init__.pyi', true)];
        }
        if (this.isStubsPath(p)) {
            return [new InMemoryDirent('__static__', false)];
        }
        const key = this.getTypeshedKey(p);
        if (key !== null) {
            const prefix = key ? key + '/' : '';
            const children = new Map<string, boolean>();
            for (const k of Object.keys(TYPESHED_CACHE)) {
                if (k.startsWith(prefix)) {
                    const rel = k.substring(prefix.length);
                    const slashIdx = rel.indexOf('/');
                    if (slashIdx === -1) {
                        children.set(rel, true);
                    } else {
                        children.set(rel.substring(0, slashIdx), false);
                    }
                }
            }
            return Array.from(children.entries()).map(([name, isFile]) => new InMemoryDirent(name, isFile));
        }
        return super.readdirEntriesSync(uri);
    }

    override async readFile(uri: any): Promise<Buffer> {
        const p = this.getNormalizedPath(uri);
        if (this.isInitPath(p)) {
            return Buffer.from(CINDER_STUB_CONTENT);
        }
        const content = this.getTypeshedContent(p);
        if (content !== null) {
            return Buffer.from(content);
        }
        return super.readFile(uri);
    }

    override async readFileText(uri: any, encoding?: any): Promise<string> {
        const p = this.getNormalizedPath(uri);
        if (this.isInitPath(p)) {
            return CINDER_STUB_CONTENT;
        }
        const content = this.getTypeshedContent(p);
        if (content !== null) {
            return content;
        }
        return super.readFileText(uri, encoding);
    }
}

export type Session = {
    analyze: (sourceText: string) => Analysis;
};

export function create_session(): Session {
    const console = new NullConsole();
    const fs = new InMemoryOverlayFileSystem(createFromRealFileSystem(undefined, console));
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
        const facts = getIncandescentFacts(service.test_program.evaluator);
        const analysis = {
            sourceText,
            root: parseResults.parserOutput.parseTree,
            parseResults,
            evaluator: service.test_program.evaluator,
            facts,
            diagnostics: sourceFile.getDiagnostics?.() ?? [],
            offsetAt: (range: any) => ({
                start: (line_ranges[range.start.line]?.start ?? 0) + range.start.character,
                end: (line_ranges[range.end.line]?.start ?? 0) + range.end.character,
            }),
        };
        facts.warm(analysis.root);
        return analysis;
    };

    return { analyze };
}
