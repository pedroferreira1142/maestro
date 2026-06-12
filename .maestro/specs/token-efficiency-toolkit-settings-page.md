# Token Efficiency toolkit + settings page

Reduce Claude token usage across Maestro sessions by integrating token-saving tools (rtk-style command output compression, a code-graph/repo-map provider, structural search) and proven techniques (prompt caching, tool-output truncation hooks, per-session token budgets). Expose everything in a new dedicated 'Token Efficiency' settings page with per-tool toggles and per-repo/per-session configuration.

## Specs

- [ ] Research pass: survey current token-reduction tools and techniques for Claude Code (rtk, Serena/code-graph MCP servers, aider-style tree-sitter repo maps, ast-grep, prompt caching, PostToolUse output-truncation hooks, small-model delegation) and write findings to docs/token-efficiency.md with a recommendation per tool
- [ ] Integrate rtk-style output compression: detect/install rtk (or implement a built-in output filter) and wrap noisy commands run inside Maestro's Claude terminals so git/build/test output is compressed before reaching the model; per-session toggle
- [ ] Integrate a code graph / repo map provider: generate a compact tree-sitter symbol map per repo (or wire an MCP code-graph server) and inject/register it for each session so Claude navigates by symbols instead of full-file reads; cache and refresh it on git changes
- [ ] Add tool-output truncation hooks: configurable PostToolUse-style limits for giant outputs (lockfiles, logs, node_modules listings) with sensible defaults
- [ ] New Settings -> Token Efficiency page: master on/off, per-tool toggles (rtk/output filter, code graph, truncation hooks, prompt-caching hints), per-repo and per-session overrides, and a status indicator showing which tools are active in the focused session
- [ ] Show token-usage feedback in the UI: per-terminal token counters (or estimates) and an indicator of estimated savings when efficiency tools are enabled
- [ ] Persist all settings in Maestro's existing config store and apply them when spawning new Claude terminals; existing sessions pick up changes on restart of their terminal
