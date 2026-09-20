# Project Guide

## Architecture

This is a static, single-page ERP application. `index.html` contains the complete original markup, application state, business logic, and rendering functions. `styles.css` is an additive presentation layer that modernizes the interface without changing application content or behavior.

## Key files

- `index.html`: page structure and all ERP behavior.
- `styles.css`: MIUI-inspired visual system, responsive rules, interaction states, and print refinements.
- `.netlify/results.md`: delivery summary generated for the current task.

## Conventions

- Keep all user-facing copy and existing data fields unchanged unless the user explicitly requests content edits.
- Make visual changes in `styles.css` where possible instead of rewriting application markup.
- Preserve existing element IDs and inline event handlers because the JavaScript relies on them.
- Maintain mobile behavior at the `767px` breakpoint and keep print-specific invoice behavior intact.

## Non-obvious decisions

The project intentionally keeps the source application's CDN dependencies and browser storage behavior. The redesign is isolated in a stylesheet so the original operational logic remains auditable and unchanged.
