# Pyrightification issues

Goal: move semantic collectors from local AST heuristics to Pyright-owned facts. Parse-backed rendering/range plumbing can stay custom.

## Priority issues

| ID | Area | Problem | Target |
|---|---|---|---|
| P0 | Read/write classification | `is_write_use` climbs AST and guesses Python binding semantics. Already caused `a.b = rhs` to mark base object as written. | Expose/use Pyright binder/evaluator symbol access facts, or add a Pyright helper that classifies a name/member node as read/write/decl/call. |
| P1 | Write value mapping | `write_value_range` guesses which RHS span belongs to a write. Incomplete for destructuring, chained assignment, walrus, for/with/except targets, comprehensions. | Expose/use Pyright assignment target mapping: target node -> value/source expression where meaningful. |
| P2 | Call target resolution | `resolve_call_target` picks decls manually and chases class `__init__`. Misses overload resolution, bound methods, descriptors, callable instances, `__new__`, protocols. | Use/extend Pyright call-resolution data. |
| P3 | Arg-to-param mapping | Fallback arg matcher is custom and incomplete. | Use Pyright call-arg mapping exclusively; extend fork if unavailable/incomplete. |
| P4 | Implicit dunder dispatch | Syntax -> dunder mapping is local and partial. | Prefer Pyright operator/magic-method resolution and cache resolved implicit calls. |
| P5 | Builtin protocol dispatch | `len(x)` -> `__len__` etc. is a local table. | Prefer Pyright builtin/protocol knowledge or centralize in Pyright helper. |
| P6 | Override/tie computation | Uses Pyright MRO/fields but manually links override chains and params positionally. | Use/extend Pyright override/member relationship helpers. |
| P7 | Return extraction | Pure AST return-expression walk; not semantic for generators/async/implicit None/unreachable. | Decide UI semantics; use Pyright return/inferred return facts where semantic precision is desired. |
| P8 | Role classification | Custom role taxonomy from decl kind/scope. | Use Pyright scope/declaration facts more directly; remove numeric enum guesses. |

## Non-issues / okay custom

- Syntax highlighting from parse nodes/tokens.
- Line ranges and char offsets.
- Segment trees, grouping, deduping, and visual reflow merging.
- UI choice to display RHS as write span, as long as target/value mapping comes from Pyright-backed facts.

## Next architecture push

The next level is to make Pyright cache semantic facts while it is already binding/evaluating, then have Incandescent consume those facts instead of recomputing them on demand.

| ID | Next step | Desired Pyright-owned fact |
|---|---|---|
| N1 | Central Incandescent fact API | One Pyright-side module/API exposing usage, calls, implicit calls, overrides, returns. |
| N2 | Symbol access facts | `node -> { declaration, accessKind: read/write/delete/declare/call, valueNode? }`. |
| N3 | Assignment target/value mapping | `target node -> assigned value/source node`, including destructuring, chained assignment, for/with/except/walrus/patterns/imports. |
| N4 | Resolved call records | `callNode -> { selected declaration(s), selected overload/signature, returnType, argParamMap }`. |
| N5 | Implicit protocol call records | `syntax node -> { methodName, declaration, selfNode, argNodes, resultType }` from operator/protocol evaluation. |
| N6 | Override relationship facts | `decl -> overridden decls / overriding decls`, plus parameter correspondence where Pyright can provide it. |
| N7 | Return facts | reachable return/yield expressions, inferred return type, implicit `None`, generator/async/NoReturn flags. |
| N8 | Delete fallbacks | Remove downstream manual call target, arg matching, dunder lookup, and optional closed-world recovery where Pyright facts suffice. |

## Remaining deepening work

These are the next "Pyright deepening" targets after the initial fact API and fallback deletion.

| ID | Deepening target | Notes |
|---|---|---|
| D1 | Populate `IncandescentFacts` from binder/evaluator caches during normal Pyright analysis | Initial done: facts are warmed immediately after analysis creation and cached before collectors run. Remaining: have binder/evaluator write facts directly at the moment Pyright computes them. |
| D2 | Exact assignment source mapping for starred destructuring and iterables | Improved: tuple/list RHS starred destructuring maps prefix/suffix targets exactly and star target to the middle source span. Non-tuple iterables still map to the iterable expression. |
| D3 | Import binding semantics | Initial done: import aliases, bare imports, and `from x import y` bindings are write bindings. Bare imports use Pyright-side synthetic declarations when Pyright exposes no declaration object for the name. |
| D4 | Pattern matching value-source mapping | Initial done: captures now use the enclosing match subject as value source. Remaining: precise subject/subpattern mapping from Pyright pattern narrowing. |
| D5 | Rich return facts in UI | Mostly done: return facts expose reachable returns, inferred return type, async/generator/async-generator flags, `yield`, `yield from`, implicit `None`, and NoReturn. Remaining only if needed: yield/send/return type split. |
| D6 | Remove/replace closed-world member type recovery | Done initially: downstream closed-world type recovery was removed; types now fail closed to Pyright. Future work can expose richer Pyright member facts if needed. |

## Simplification after deepening

After D1-D6, preserve pyrightness by simplifying Incandescent around Pyright-owned facts rather than reintroducing local semantic logic.

| ID | Simplification | Rule |
|---|---|---|
| S1 | Treat `a.facts` as the only semantic API | Collectors should not call evaluator internals directly except for rendering-only type printing; prefer adding a Pyright fact method. |
| S2 | Delete duplicate helper wrappers | Remove downstream wrappers like `resolve_call_target`, `match_call_args`, `returns_in_function` if they become one-line `a.facts` reads. |
| S3 | Make collectors declarative | Collectors should map Pyright fact records to ranges/tables, not decide Python semantics. |
| S4 | Keep UI policy separate from facts | Choices like displaying RHS as a write span belong in Incandescent; deciding which target/value pair exists belongs in Pyright facts. |
| S5 | Add regression tests for every semantic fact | Any bug fix in read/write/call/arg/override/return semantics gets a test in `tests/pyrightification.test.ts`. |
| S6 | Ban new local semantic fallbacks | If Pyright facts are missing, add/extend facts in the fork rather than guessing in `collectors.ts` or `incandescent.ts`. Guarded by `tests/pyrightification.test.ts`. |
| S7 | Centralize type formatting only | `print_type` and visual string formatting can stay downstream, but type computation should come from Pyright facts/evaluator. |
| S8 | Shrink `data.json` semantic tables | Keep styling/config data, but migrate operator/builtin/protocol semantic tables into Pyright fact modules or real Pyright caches. |
| S9 | Document fact ownership | Each fact API should say whether it is binder-populated, evaluator-populated, or Incandescent UI-derived. |
| S10 | Prefer failing closed over guessing | If a Pyright fact is unavailable, omit that relationship rather than producing a potentially wrong semantic link. |

## Work log

- [x] P3: audit/use Pyright call arg mapping.
  - Extended fork cache to include `paramCategory` and `mapsToVarArgList` so `**kwargs` and `*args` map to the real variadic parameter rather than the surface keyword.
  - Collector now forces Pyright call evaluation, trusts cached `matchArgsToParams` output, and only falls back when Pyright produced no cache.
- [x] P0/P1 initial: replace downstream read/write target detection with a Pyright-fork helper.
  - Added `incandescentUsageUtils` inside `pyright/packages/pyright-internal/src/analyzer` plus compiled JS mirror.
  - Collector now calls `getIncandescentUsageInfo` instead of doing local AST climbing.
  - Extended Pyright-side helper for tuple/list destructuring, walrus targets, for targets, with-as targets, and except-as names.
  - Still needs even deeper binder-backed coverage for comprehensions/pattern matching and exact iterator element mapping for loop destructuring.
- [x] P2: replace call target resolution.
  - Added Pyright fork helper `incandescentCallUtils.getIncandescentCallTargetDeclarations` that queries evaluator signature info after call evaluation.
  - Collector now prefers Pyright signature-derived function declarations, covering bound methods, constructors with `__init__`, and callable instances via `__call__`.
  - Manual declaration chasing fallback was later removed in N8; calls now trust Pyright facts.
- [x] P4/P5 initial: move implicit call facts closer to Pyright.
  - Added Pyright fork helper `incandescentDunderUtils.getIncandescentImplicitCalls`.
  - Syntax-to-protocol mapping and `getBoundMagicMethod` lookup now live in the Pyright fork; downstream collector consumes resolved declarations when available.
  - Builtin surface calls like `len(x)` now also live in the Pyright helper via `getIncandescentBuiltinProtocolCalls`.
- [x] P6 initial: improve override ties.
  - Added Pyright fork helper `incandescentOverrideUtils.getIncandescentOverridePairs`.
  - Collector no longer manually walks MRO/fields downstream; it consumes Pyright-side override pairs and only does source-range parameter linking locally.
- [x] P7 initial: make returns reachability-aware.
  - `returns_in_function` now asks Pyright `evaluator.isNodeReachable` before recording return/lambda body spans.
  - Still intentionally records syntactic return expressions rather than trying to model inferred return types.
- [x] N7 initial: centralize return facts in Pyright fact API.
  - Added `incandescentReturnUtils.getIncandescentReturnInfo` in the Pyright fork.
  - `a.facts.getReturnInfo` now caches reachable return/lambda expressions and also captures Pyright's inferred return type for future UI use.
  - Downstream `returns_in_function` is now a thin facts API read.
- [x] P8: remove declaration numeric constants where possible.
  - Collector now imports Pyright declaration predicate helpers instead of pinning `DeclarationType` numbers.
- [x] N1 initial: central Incandescent fact API.
  - Added `incandescentFacts` in the Pyright fork and attached `facts` to each `Analysis` object.
  - Collectors now consume `a.facts` for usage info, call info, implicit calls, builtin protocol calls, override pairs, and reachability.
  - This consolidates semantic seams behind one Pyright-owned API and prepares the next step: replacing on-demand helpers with evaluator/binder-populated caches.
  - Added per-evaluator WeakMap caches for usage, call info, implicit calls, builtin protocol calls, override pairs, and reachability.
- [x] N3 initial: expand Pyright-side assignment target/value mapping.
  - Pattern matching captures are now write bindings (`case [c, d]`, `case e`, class pattern capture args, and `as` targets).
- [x] N2 initial: move call-site usage classification into Pyright facts.
  - `incandescentUsageUtils` now classifies call-target nodes as `call` (`f()`, `obj.m()`, nested member call targets) while preserving base-object reads.
  - Downstream collector no longer uses its own `is_call_site` AST walk for mode selection; it consumes `a.facts.getUsageInfo`.
  - `getUsageInfo` now enriches usage facts with Pyright declarations from `getDeclInfoForNameNode`, centralizing symbol access facts further.
- [x] N4 initial: enrich resolved call records.
  - `a.facts.getCallInfo` now caches selected declarations, arg-param map, call return type, and callee type.
  - This prepares UI and collectors to use Pyright call records without recomputing type/call facts downstream.
- [x] N5 initial: enrich implicit protocol call records.
  - `IncandescentImplicitCall` now carries Pyright-computed `resultType` via `getTypeOfMagicMethodCall` in addition to the resolved declaration.
- [x] N6 initial: move override parameter correspondence into Pyright facts.
  - `incandescentOverrideUtils` now emits `parameterPairs` as declaration objects.
  - Downstream tie computation no longer pairs override parameters positionally itself; it only maps Pyright-provided declaration pairs to ids.
- [x] Sanity tests for N2-N7.
  - Added `tests/pyrightification.test.ts` covering usage facts, assignment/pattern writes, call records, arg mapping, implicit/builtin protocol calls, override parameter pairs, and return facts.
  - Added `bun run test` script.
- [x] N8 initial: delete downstream semantic fallbacks.
  - Removed manual call target fallback from `resolve_call_target`; it now trusts `a.facts.getCallInfo`.
  - Removed manual arg-to-param matcher fallback from `match_call_args`; it now trusts Pyright arg maps.
  - Removed downstream dunder declaration fallback from call collection; implicit/builtin protocol calls now require fact-provided declarations.
  - Removed closed-world member type recovery; Incandescent now fails closed when Pyright has no type.
- [x] S2 initial: delete duplicate fact-read wrappers.
  - Removed downstream wrappers for call target resolution, implicit/builtin protocol dispatch, return extraction, and call-site/write checks.
  - `incandescent.ts` and tests now read `a.facts` directly for those facts.
- [x] S2 arg-map cleanup: delete downstream `match_call_args` wrapper.
  - `a.facts.getCallInfo(...).argMap` now carries `paramDecl` directly from Pyright-side facts.
  - Explicit call argument collection maps `paramDecl` straight to visualizer ids with no downstream arg/param remapping.
- [x] S2 implicit-call arg cleanup: delete downstream implicit arg/param remapping.
  - `IncandescentImplicitCall` now carries `argMap` entries with `argExpr` and `paramDecl`.
  - Implicit dunder call collection maps those Pyright-side param declarations directly to ids.
  - Removed the downstream `record_call`, `decl_for_param_name_node`, and `is_method` helpers.
- [x] S2 annotation-owner cleanup: move annotation owner facts into Pyright facts.
  - `a.facts.getAnnotationOwners(root)` now returns annotation node + owner declaration pairs.
  - Deleted the custom Function/Parameter/TypeAnnotation owner walk from `incandescent.ts`; downstream only maps owner declarations to ids.
  - Added regression coverage for parameter, return, and variable annotations.
- [x] P8/S2 role cleanup: move declaration role facts into Pyright facts.
  - Added `a.facts.getDeclarationRole(decl)`.
  - Deleted downstream `classify_role` and its scope/enclosing-kind logic.
  - Role collection now maps Pyright-side role facts to ids only.
  - Added regression coverage for global/member/local/function/method param and return roles.
- [x] S2 definition cleanup: move definition fact construction into Pyright facts.
  - Added `a.facts.getDefinitionForNode(node)` returning declaration, name, range, synthetic span, and type.
  - `pyright_decl` is now only a thin adapter from Pyright facts to visualizer `DefinitionInfo` shape.
  - Added regression coverage for definition facts.
- [x] D2/D3 initial: starred assignment and import binding facts.
  - Pyright-side usage facts now treat `*target` in destructuring as a write; tuple/list RHS maps prefix/suffix exactly and the star target to the middle source span.
  - Pyright-side usage facts now treat bare imports, import aliases, and `from x import y` bound names as write bindings.
  - Added regression coverage for starred destructuring and import binding semantics.
- [x] D4 initial: pattern value-source mapping.
  - Pattern captures now use the enclosing match subject as their write value source.
  - Added regression coverage through the existing pattern write test.
- [x] D1 initial: warmed/cached facts during analysis creation.
  - `IncandescentFacts` now exposes `warm(root)` and `stats()`.
  - `init.ts` warms usage, call, implicit, builtin, return, and reachability facts immediately after Pyright analysis creates parse/evaluator results.
  - Added regression coverage that facts are populated and cached before collector use.
- [x] D5 initial: richer return facts.
  - Return facts now expose `yields`, `yieldFroms`, `isAsync`, `isGenerator`, `isAsyncGenerator`, `hasImplicitNone`, and `isNoReturn` in addition to reachable return expressions and inferred return type.
  - Added regression coverage for async functions and generators.
  - Made `Analysis.facts` required and removed optional fact reads in collectors.
