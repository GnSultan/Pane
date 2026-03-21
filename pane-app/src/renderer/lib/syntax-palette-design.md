# Pane Syntax Highlighting Palette - Complete Redesign

## Philosophy: "Radically Minimal, Deeply Meaningful"

Instead of just different grays, we need:
1. **Semantic color categories** that map to code meaning
2. **High contrast ratios** for accessibility
3. **Subtle variations** that don't overwhelm
4. **Theme coherence** across Ink/Paper/Pure

## Color Categories (with rationale)

### 1. **Structure & Flow** (Blues/Cool Grays)
- Keywords, operators, control flow
- `--pane-syn-structure`: #7A8B9C (muted blue-gray)

### 2. **Data & Literals** (Warm Amber/Yellows)
- Strings, numbers, booleans
- `--pane-syn-data`: #C9AE6E (amber)
- `--pane-syn-data-number`: #B8A56A (darker amber)

### 3. **Identity & Names** (Neutral Grays)
- Variables, properties, object keys
- `--pane-syn-identity`: #C8C5BE (light warm gray)

### 4. **Functions & Methods** (Subtle accent)
- Function names, methods, calls
- `--pane-syn-function`: #9BA8B8 (muted blue-gray)

### 5. **Types & Classes** (Distinguished gray)
- Types, classes, interfaces
- `--pane-syn-type`: #8A95A5 (medium blue-gray)

### 6. **Comments & Metadata** (Very muted)
- Comments, annotations
- `--pane-syn-comment`: #5A5752 (dark warm gray)

### 7. **JSX/HTML Specific** (Tag colors)
- Tags, attributes, JSX
- `--pane-syn-tag`: #A8A59E (muted khaki)
- `--pane-syn-attribute`: #B8A56A (amber)

## Detailed Token Mapping

### Ink (Dark) Theme:
```css
--pane-syn-structure: #7A8B9C;    /* Keywords, operators */
--pane-syn-data: #C9AE6E;         /* Strings */
--pane-syn-data-number: #B8A56A;  /* Numbers */
--pane-syn-identity: #C8C5BE;     /* Variables, properties */
--pane-syn-function: #9BA8B8;     /* Functions */
--pane-syn-type: #8A95A5;         /* Types, classes */
--pane-syn-comment: #5A5752;      /* Comments */
--pane-syn-tag: #A8A59E;          /* JSX/HTML tags */
--pane-syn-attribute: #B8A56A;    /* Attributes */
```

### Paper (Light) Theme:
```css
--pane-syn-structure: #5A6B7C;    /* Keywords, operators */
--pane-syn-data: #8A6F20;         /* Strings */
--pane-syn-data-number: #9A7F30;  /* Numbers */
--pane-syn-identity: #2C2B28;     /* Variables, properties */
--pane-syn-function: #4A5B6C;     /* Functions */
--pane-syn-type: #5A6A7A;         /* Types, classes */
--pane-syn-comment: #A5A29A;      /* Comments */
--pane-syn-tag: #5A5752;          /* JSX/HTML tags */
--pane-syn-attribute: #9A7F30;    /* Attributes */
```

### Pure (High Contrast) Theme:
```css
--pane-syn-structure: #4A5A6A;    /* Keywords, operators */
--pane-syn-data: #7A5F10;         /* Strings */
--pane-syn-data-number: #8A6F20;  /* Numbers */
--pane-syn-identity: #2C2B28;     /* Variables, properties */
--pane-syn-function: #3A4A5A;     /* Functions */
--pane-syn-type: #4A5A6A;         /* Types, classes */
--pane-syn-comment: #767676;      /* Comments */
--pane-syn-tag: #4A4A4A;          /* JSX/HTML tags */
--pane-syn-attribute: #8A6F20;    /* Attributes */
```

## Token to CSS Variable Mapping

### JavaScript/TypeScript:
- Keywords (`if`, `for`, `return`) → `--pane-syn-structure`
- Operators (`+`, `-`, `=`) → `--pane-syn-structure`
- Strings → `--pane-syn-data`
- Numbers → `--pane-syn-data-number`
- Comments → `--pane-syn-comment`
- Function names → `--pane-syn-function`
- Variable names → `--pane-syn-identity`
- Property names → `--pane-syn-identity`
- Types → `--pane-syn-type`
- Classes → `--pane-syn-type`
- `const`, `let`, `var` → `--pane-syn-structure`

### JSX:
- HTML tags → `--pane-syn-tag`
- Component names → `--pane-syn-function`
- JSX attributes → `--pane-syn-attribute`
- Props values → `--pane-syn-data`

### Built-ins:
- `console`, `Math`, etc. → `--pane-syn-type`
- `true`, `false`, `null`, `undefined` → `--pane-syn-structure`