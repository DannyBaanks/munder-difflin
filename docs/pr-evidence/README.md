# PR evidence — screenshots

Historical screenshots retained for documentation and release history. They are
not a pull-request requirement or CI gate.

- `before-en.png` — the UI in English before the change.
- `after-zh.png` — the same screen with 简体中文 selected in Settings → General.
- `before-task-id.png` / `after-task-id.png` — the Tasks kanban DOING column
  without and with the task id on each card (#352). Rendered off the real
  `TaskCard` component with the real design tokens and bundled fonts, at one
  window size against one fixed set of cards, so the pair differs only by the
  change itself.
- `before-task-id-detail.png` / `after-task-id-detail.png` — the task DETAIL view
  without and with the id in its fact row (#352). Same approach: the real
  `TaskDetail`, real tokens and fonts, real English strings, one fixed task.
