# Ideation Workbench

A fully local, single-user ideation application for Windows. The interface runs in your browser at `localhost`, while a tiny local Node.js service stores each project in a user-selected portable folder.

## Run it on Windows

1. Install the current **Node.js 24 LTS** release if Node.js is not already installed.
2. Extract this folder anywhere.
3. Double-click `start.bat`.
4. Your browser opens to `http://127.0.0.1:4317`.
5. Choose or create a project folder.

There is no dependency installation step. The app uses only browser features and Node.js built-ins.

## Project folder layout

```text
My Project/
├─ project.sqlite
├─ attachments/
└─ backups/
   └─ 2026-07-23T12-34-56-000Z/
      ├─ project.sqlite
      ├─ attachments/
      └─ backup.json
```

Backups are created automatically after saves, at most once every five minutes, and can also be created manually. The newest 20 backups are retained.

## Implemented behavior

- One selected theme at a time, with parent/child inheritance.
- Ideas with succinct titles and rich-text details.
- Ideas can belong to multiple optional idea groups.
- Single-group card colors and blended multi-group card backgrounds with automatic foreground contrast.
- Implementations link to one or many ideas, themes, and implementation groups.
- Persistent semantic implementation-group ↔ idea-group connections that do not expand into individual links.
- Shared implementations repeat beneath each linked idea but remain one object.
- Multi-member conflicts: `{A, B, C}` is invalid only when all three are selected.
- Global and theme-scoped conflicts, inherited conflict hiding, and child-theme overrides.
- Locking that immediately marks and moves incompatible implementations below compatible ones.
- Excluded implementations sort by the number of currently blocking conflicts.
- Per-implementation visibility plus Show all, Hide all, and Restore previous visibility.
- Named simple saves (locks only) and rich saves (locks, visibility, expansion, search, and filters).
- Right-side implementation notes inspector with local attachments.
- Portable SQLite project storage and timestamped backups.

## Development and checks

```powershell
npm test
npm start
```

The test suite covers theme inheritance and the multi-member conflict completion rule.

## Notes

- The server binds only to `127.0.0.1`; it is not exposed to your local network.
- The app itself does not call external APIs, CDNs, analytics, or telemetry.
- Light, dark, and OS-aware auto color modes, switchable from the top bar.
- The native Browse button opens the OS folder picker (Windows, macOS, and Linux). A path can also be entered manually.

## Included project

The download now includes `projects/network-mechanics-ideas-only-project`, containing the seeded network-mechanics ideas. It is listed on the opening screen under **Included projects** and can also be opened by entering that folder path manually.

## Theme creation

Use the permanent **+ Theme** button beside the theme dropdown. Theme management also remains available under **Structure**.
