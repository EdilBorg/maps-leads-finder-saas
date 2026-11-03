# Linear — Style Reference
> midnight precision instrument

**Theme:** dark

Source measurements are normalized; roles and recommendations are interpreted. Font summary lists are independent, not paired by position. HTML examples are reconstructions, not source components.

Linear's design system is a midnight command center built on near-black surfaces (#08090a) with paper-white type and one electric acid-lime accent (#e4f222) that functions as a functional flashlight — small, high-contrast, and used sparingly to signal action. The interface treats darkness as a substrate rather than a theme: text is crisp white at tight tracking (-0.022em), weights sit in a low 400–510 band rather than bold, and borders are hairline-thin (0.5px) to let geometry do the work that shadows usually would. Components feel precision-machined — 6px and 12px radii, compact 8–12px paddings, and almost no decorative ornament — letting the product UI (issue cards, kanban boards, AI agent panels) be the only visual texture in an otherwise quiet system.

## Tokens — Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Void | `#08090a` | `--color-void` | Page canvas, full-bleed backgrounds — the default everything sits on |
| Carbon | `#0f1011` | `--color-carbon` | Card surfaces, nav bars — one step above canvas for contained content |
| Obsidian | `#161718` | `--color-obsidian` | Elevated surfaces, deeper card panels |
| Graphite | `#23252a` | `--color-graphite` | Subtle borders, dividers, ghost button outlines — low-contrast structural edges |
| Smoke | `#383b3f` | `--color-smoke` | Hairline borders at higher contrast than graphite — section separators |
| Ash | `#62666d` | `--color-ash` | Muted body text, inactive icons, secondary metadata |
| Fog | `#8a8f98` | `--color-fog` | Tertiary text, placeholder copy, icon fills |
| Mist | `#d0d6e0` | `--color-mist` | Secondary headings, button text on dark surfaces |
| Bone | `#e5e5e6` | `--color-bone` | Near-white surface fills, high-contrast button text |
| Paper | `#ffffff` | `--color-paper` | Primary headings, hero type, max-contrast emphasis text |
| Acid Lime | `#e4f222` | `--color-acid-lime` | Primary action buttons, active nav indicators — electric accent that breaks the monochrome system |
| Pulse Green | `#27a644` | `--color-pulse-green` | Green outline accent for tags, dividers, and focused UI edges. Use as a supporting accent, not as a status color |
| Coral Red | `#eb5757` | `--color-coral-red` | Red wash for highlight backgrounds, decorative bands, and soft emphasis behind content. Use as a supporting accent, not as a status color |
| Signal Teal | `#02b8cc` | `--color-signal-teal` | Decorative accent, informational icon fills |
| Iris Violet | `#6366f1` | `--color-iris-violet` | Tag/badge fills — soft chromatic punctuation on tags and labels |
| Lavender | `#8b5cf6` | `--color-lavender` | Secondary tag fills, category indicators |

## Tokens — Typography

### Inter Variable — Primary UI and heading typeface
- **Substitute:** Inter (variable), or system-ui as fallback
- **Weights:** 300, 400, 510, 590
- **Role:** Primary UI and heading typeface — used across nav, body, headings, buttons, cards

### Berkeley Mono — Code-adjacent UI text
- **Substitute:** JetBrains Mono, IBM Plex Mono, or ui-monospace
- **Weights:** 400
- **Role:** Code-adjacent UI text — issue IDs, keyboard shortcuts, monospaced metadata

## Do's and Don'ts

### Do
- Use #e4f222 exclusively for the single primary action per view — never for decoration, never for secondary buttons
- Set card radius to 12px, button radius to 6px, pill radius to 9999px
- Use 0.5px hairline borders instead of shadows for surface separation
- Keep section gaps at 96px and element gaps at 8px

### Don't
- Do not use bold weights (700+)
- Do not use decorative gradients on buttons, cards, or text
- Do not introduce additional chromatic accent colors as actions — the acid-lime button is the only chromatic UI element
- Do not use large radii (16px+) on cards or panels
- Do not use chromatic text colors for body copy

## Quick Color Reference
- text (primary heading): #ffffff
- text (body): #d0d6e0
- text (muted): #8a8f98
- background (canvas): #08090a
- background (card): #0f1011
- border (hairline): #23252a
- accent (CTA): #e4f222

*Documento de referência visual oficial do projeto Maps Leads Finder SaaS. Conteúdo alinhado ao DESIGN.md fornecido na Etapa 3.*
