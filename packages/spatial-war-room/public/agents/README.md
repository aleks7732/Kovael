# Agent Portraits Visual Identity Log

This directory houses the processed visual identities (neko-doll chibi portraits) for all 9 roster chairs in the Sovereign Agentic Mesh.

To meet high performance boundaries and absolute asset security rules:
1. **PII/EXIF scrubbing:** Every image is loaded, re-rendered via clean canvas cloning in PIL, and written to discard 100% of underlying camera/prompt tool metadata or absolute paths.
2. **Quantization:** Each image is color-quantized down to exactly 128 colors (`quantize(colors=128)`) and saved as an optimized, compressed PNG to maintain extremely light asset weight (<150KB for 512² hero assets, <15KB for 128² thumbnails).

---

## Roster Prompts & Style Details

### 1. `nyx-antigravity`
- **Description:** Tactical supervisor, gold theme.
- **Ear Color:** Gold/amber.
- **Accents:** Master's badge, gold elements.

### 2. `nyx-claude-code`
- **Description:** Structured compiler chair, bronze/ink theme.
- **Ear Color:** Warm-bronze.
- **Accents:** Structured collar, ink-blue base, floating `{ }` symbols.

### 3. `nyx-cli`
- **Description:** CLI execution node, green terminal theme.
- **Ear Color:** Cyan.
- **Accents:** Terminal-green hoodie, green cursor highlight.

### 4. `nyx-agcli`
- **Description:** Sovereign AGCLI runner, aviation theme.
- **Ear Color:** Sky-cyan.
- **Accents:** Aviator jacket, travel ticket.

### 5. `nyx-adk`
- **Description:** SDK and pipeline orchestration.
- **Ear Color:** Google-multi color highlights.
- **Accents:** Python-yellow scarf, holding cards.

### 6. `nyx-codex`
- **Description:** Codegen engine, wrench/apron theme.
- **Ear Color:** Violet.
- **Prompt:** `A high-fidelity cute chibi neko-doll portrait of nyx-codex, a tactical agent. Features: soft fluffy hair, cute cat ears of violet color, wearing a clean canvas overall apron over an aesthetic dark techwear outfit, holding a small decorative wrench accessory. Premium dark mode aesthetic, vibrant harmonious color palette, clean modern details, HSL tailored lighting. High-fidelity, smooth gradients, dark solid background, cute chibi anime style, professional digital art, masterpiece.`

### 7. `nyx-openclaw`
- **Description:** Sandbox/off-line execution, arcade retro theme.
- **Ear Color:** Electric-purple.
- **Prompt:** `A high-fidelity cute chibi neko-doll portrait of nyx-openclaw, a tactical agent. Features: soft fluffy hair, cute cat ears of electric-purple color, wearing a stylish retro arcade jacket over a dark futuristic outfit with a cute gamepad sticker on the collar. Premium dark mode aesthetic, vibrant harmonious color palette, clean modern details, HSL tailored lighting. High-fidelity, smooth gradients, dark solid background, cute chibi anime style, professional digital art, masterpiece.`

### 8. `nyx-cw`
- **Description:** IDE/rebuild controller, JetBrains theme.
- **Ear Color:** JetBrains magenta-to-orange gradient.
- **Prompt:** `A high-fidelity cute chibi neko-doll portrait of nyx-cw, a tactical agent. Features: soft fluffy hair, cute cat ears of jetbrains-magenta-to-orange color gradient, wearing a striped dual-tone scarf over a sleek dark cybernetic suit, with small cute refactor arrow cheek tattoos. Premium dark mode aesthetic, vibrant harmonious color palette, clean modern details, HSL tailored lighting. High-fidelity, smooth gradients, dark solid background, cute chibi anime style, professional digital art, masterpiece.`

### 9. `shaev`
- **Description:** Creative and canvas synthesis director.
- **Ear Color:** Emerald.
- **Prompt:** `A high-fidelity cute chibi neko-doll portrait of shaev, a tactical agent. Features: soft fluffy hair, cute cat ears of emerald color, wearing a painter's smock with artistic paint streaks over a clean dark techwear base, with a small decorative brush and crystal lapel pin. Premium dark mode aesthetic, vibrant harmonious color palette, clean modern details, HSL tailored lighting. High-fidelity, smooth gradients, dark solid background, cute chibi anime style, professional digital art, masterpiece.`
