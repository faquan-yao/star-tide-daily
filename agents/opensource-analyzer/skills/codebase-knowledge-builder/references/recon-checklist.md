# Codebase Reconnaissance Checklist

Use this checklist during Phase 1 (Reconnaissance) to build a complete mental model of the codebase before diving into specific topics.

## Repository Structure

- [ ] Clone the repo and list top-level directories
- [ ] Count total source files by extension (`find . -type f -name '*.js' | wc -l`)
- [ ] Identify the primary language and framework
- [ ] Locate the main entry point (e.g., `index.js`, `main.py`, `app.ts`)
- [ ] Map the directory tree to understand module boundaries

## Architecture Discovery

- [ ] Read the entry point file end-to-end
- [ ] Identify the service/module initialization order
- [ ] Map imports to understand dependency graph between core modules
- [ ] Identify the configuration system (env vars, config files, Redis, etc.)
- [ ] Locate the routing layer (HTTP routes, socket handlers, CLI commands)

## Key Abstractions

- [ ] Identify base classes, interfaces, or abstract patterns
- [ ] Locate factory or builder patterns
- [ ] Find middleware chains and their ordering
- [ ] Identify the plugin/extension mechanism (if any)

## Data Flow

- [ ] Trace a request from entry to response (happy path)
- [ ] Identify the state management approach (in-memory, Redis, DB)
- [ ] Locate caching layers and their invalidation strategy
- [ ] Find the serialization/deserialization boundaries

## Save Findings

After completing reconnaissance, save a structured summary to `findings.md` with:
- Tech stack and framework versions
- Directory structure overview
- Core module map (module -> responsibility)
- Key design patterns identified
- Questions or ambiguities to resolve during deep-dive phases
