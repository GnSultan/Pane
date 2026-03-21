# ACE Editor Token Types Analysis

## Core Token Types (from ACE documentation)

### Basic Tokens:
- `ace_keyword` - Language keywords (if, for, return, etc.)
- `ace_string` - String literals
- `ace_constant` - Constants
- `ace_constant.ace_numeric` - Numbers
- `ace_comment` - Comments
- `ace_function` - Function names
- `ace_variable` - Variables/identifiers
- `ace_operator` - Operators (+, -, =, etc.)

### Support Tokens (ace_support):
- `ace_support.ace_function` - Built-in functions
- `ace_support.ace_type` - Types (string, number, etc.)
- `ace_support.ace_class` - Classes
- `ace_support.ace_constant` - Built-in constants
- `ace_support.ace_other` - Other support types

### Entity Tokens:
- `ace_entity.ace_name.ace_function` - Function names in declarations
- `ace_entity.ace_name.ace_tag` - HTML/JSX tags
- `ace_entity.ace_other.ace_attribute-name` - Attribute names

### Storage Tokens:
- `ace_storage` - Storage keywords (var, let, const, function, class)
- `ace_storage.ace_type` - Type storage

### Meta Tokens:
- `ace_meta.ace_tag` - Meta tags

### Markup Tokens (for Markdown):
- `ace_markup.ace_heading` - Headings
- `ace_markup.ace_list` - Lists
- `ace_markup.ace_quote` - Blockquotes
- `ace_markup.ace_underline.ace_link` - Links

### JSX-Specific Tokens:
- `ace_jsx` - JSX identifiers
- `ace_jsx.ace_tag` - JSX tags
- `ace_jsx.ace_attribute-name` - JSX attributes
- `ace_jsx.ace_string` - JSX strings

### Current Coverage in pane-ace-theme.js:
✓ ace_constant.ace_numeric
✓ ace_comment
✓ ace_function
✓ ace_support.ace_function
✓ ace_support.ace_type/ace_class/ace_other
✓ ace_keyword.ace_operator
✓ ace_variable
✓ ace_entity.ace_name.ace_function
✓ ace_storage
✓ ace_keyword
✓ ace_string
✓ ace_entity.ace_other.ace_attribute-name

### Missing Coverage:
❌ ace_jsx (JSX-specific tokens)
❌ ace_jsx.ace_tag
❌ ace_jsx.ace_attribute-name
❌ ace_jsx.ace_string
❌ ace_meta
❌ ace_invalid
❌ ace_invisible
❌ ace_fold
❌ ace_markup (Markdown tokens - partially covered in globals.css)

## Color Strategy for Enhanced Readability

Current color palette (Ink/Dark theme):
- --pane-syn-keyword: #A8A59E (muted gray)
- --pane-syn-string: #C9AE6E (amber-yellow)
- --pane-syn-number: #B8A56A (darker amber)
- --pane-syn-comment: #5A5752 (dark gray)
- --pane-syn-function: #C8C5BE (light gray)
- --pane-syn-type: #9D9A93 (medium gray)
- --pane-syn-operator: #8A877F (darker gray)
- --pane-syn-property: #C8C5BE (light gray - same as function!)

Issues:
1. Function and property use identical colors
2. All grays are too similar (A8A59E, C8C5BE, 9D9A93, 8A877F)
3. Limited color variety for semantic distinction

Proposed new palette:
- Keep amber accents for strings/numbers (semantic - data)
- Use grays for structure (keywords, operators, types)
- Add subtle color variations for functions, properties, variables
- Ensure high contrast and readability