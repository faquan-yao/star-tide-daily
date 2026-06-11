# Deep-Dive Methodology

## Table of Contents

1. File Reading Strategy
2. Tracing Patterns
3. Note-Taking Protocol
4. Common Subsystem Types

## 1. File Reading Strategy

Read files in dependency order, not alphabetical order. Start from the entry point of the subsystem being studied and follow imports outward. For each file:

1. Read the module-level docstring or header comment first -- it often explains the "why."
2. Identify the exported functions/classes -- these are the public API.
3. Read the constructor or initialization logic -- this reveals dependencies.
4. Read the primary execution method -- this is the core logic.
5. Scan for error handling, edge cases, and commented-out code -- these reveal history.

When a file is too long (>500 lines), use range-based reading. Start with lines 1-100 to get the imports and class definition, then jump to the method needed.

## 2. Tracing Patterns

For each subsystem, trace these three paths:

**Happy Path**: The normal, successful execution flow from trigger to completion. This is the backbone of the artifact.

**Error Path**: What happens when things go wrong. Look for try/catch blocks, error classes, fallback logic, and retry mechanisms.

**Edge Cases**: Caching behavior, race conditions, concurrent access, timeout handling. These are the gotchas that make the difference between a junior and a senior developer.

## 3. Note-Taking Protocol

After every 2-3 files read, save key findings to a scratch file. Do not rely on context window memory alone. Structure notes as:

```
## [File Path]
- Purpose: [one sentence]
- Key functions: [list]
- Calls: [what it calls]
- Called by: [what calls it]
- Gotchas: [non-obvious behavior]
```

## 4. Common Subsystem Types

Different subsystem types require different investigation angles:

| Subsystem Type | Primary Focus | Key Questions |
| :--- | :--- | :--- |
| **Request Pipeline** | Middleware chain, request/response transformation | What is the middleware order? What gets injected at each stage? |
| **Agent/LLM System** | Model loading, prompt assembly, tool binding | How are models selected? How are prompts composed? What middleware wraps the LLM? |
| **Streaming/Real-time** | Event emission, section management, callback handlers | What events are emitted? How are sections structured? What handles backpressure? |
| **Data Access Layer** | Connection pooling, query building, caching | How are connections managed? What caching strategy is used? How are schemas loaded? |
| **Worker/Task System** | Task delegation, result aggregation, error propagation | How are tasks routed? How are results collected? What happens on failure? |
| **Configuration System** | Config sources, override hierarchy, validation | What is the config precedence? How are defaults applied? What validates config? |
