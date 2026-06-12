# Factory: Agents tab connected to installed agents + agent-factory registry

Connect Maestro's Factory pane to the agents the user actually has. Add an 'Agents' tab to FactoryPane that lists installed Claude Code agents from ~/.claude/agents (user-global) and the project's .claude/agents, parsed from .md frontmatter. Enrich each entry with metadata from the external Agent Factory registry (C:\repos\agent-factory\registry\registry.json, configurable path in settings): archetype, type (domain/infrastructure), topics, keywords, related_agents, source_verified/github_verified grounding badges, and last_updated. Surface registry↔disk drift (unregistered files, missing files) and a 'factory running' badge while registry/.factory.lock exists. UX mirrors the agent-factory web app: search, domain/infra filter, archetype filter chips with counts, agent detail view with rendered markdown body and clickable related-agent links wired into the existing FactoryGraph.

## Specs

- [x] New 'Agents' tab in FactoryPane (FactoryTab union + tab strip) showing all installed agents from ~/.claude/agents and the session repo's .claude/agents, with name, description, model and scope (user-global vs project-local) parsed from frontmatter
- [x] Main-process service (extend FactoryService/FactoryWriter scanAgents or new AgentRegistryService) that reads and watches the external registry file at a configurable path, defaulting to C:\repos\agent-factory\registry\registry.json, exposed over IPC
- [x] Merge registry metadata onto installed agents: archetype, type, topics, keywords, related_agents, source_verified/github_verified, knowledge_note, created/last_updated; tolerate a missing or unparsable registry gracefully
- [x] Drift indicators: badge agents on disk that are absent from the registry ('unregistered') and registry entries whose file_path doesn't exist on disk ('missing file'); show counts in the tab badge
- [x] Search box plus domain/infrastructure filter and dynamic archetype filter chips with counts, matching the agent-factory web app sidebar UX
- [x] Agent detail view: rendered markdown body, frontmatter summary, grounding info (Confluence pages, pinned GitHub repos/SHAs), and clickable related_agents links; integrate agents as nodes in the existing FactoryGraph view
- [x] 'Factory running' indicator in the Agents tab while <registry>/.factory.lock exists, and a manual refresh plus file-watch driven auto-refresh of both the agents dir and registry.json
