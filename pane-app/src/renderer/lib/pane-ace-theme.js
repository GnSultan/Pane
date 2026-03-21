ace.define("ace/theme/pane", ["require", "exports", "ace/lib/dom"], function(require, exports) {
  "use strict";

  console.log('[ACE Theme] Custom Pane theme being defined');

  // Determine if dark mode (for isDark flag)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  exports.isDark = isDark;
  
  exports.cssClass = "ace-pane";
  exports.cssText = `
    .ace-pane .ace_gutter {
      background: var(--pane-editor-gutter);
      color: var(--pane-editor-gutter-text);
    }
    
    .ace-pane {
      background-color: var(--pane-editor-bg);
      color: var(--pane-text);
    }
    
    .ace-pane .ace_cursor {
      color: var(--pane-editor-cursor);
      border-left: 2px solid var(--pane-editor-cursor);
    }
    
    .ace-pane .ace_invisible {
      color: var(--pane-syn-comment);
    }
    
    /* Enhanced semantic syntax highlighting */
    /* Structure & Flow - control flow keywords and operators */
    .ace-pane .ace_keyword,
    .ace-pane .ace_storage,
    .ace-pane .ace_keyword.ace_operator {
      color: var(--pane-syn-structure);
    }
    
    /* Data & Literals - values */
    .ace-pane .ace_string {
      color: var(--pane-syn-data);
    }
    
    .ace-pane .ace_constant,
    .ace-pane .ace_constant.ace_numeric {
      color: var(--pane-syn-data-number);
    }
    
    /* Identity & Names - variables, properties */
    .ace-pane .ace_variable {
      color: var(--pane-syn-identity);
    }
    
    /* Functions - function names */
    .ace-pane .ace_function,
    .ace-pane .ace_support.ace_function,
    .ace-pane .ace_entity.ace_name.ace_function {
      color: var(--pane-syn-function);
    }
    
    /* Types & Classes */
    .ace-pane .ace_support.ace_type,
    .ace-pane .ace_support.ace_class,
    .ace-pane .ace_support.ace_other {
      color: var(--pane-syn-type);
    }
    
    /* Comments */
    .ace-pane .ace_comment {
      color: var(--pane-syn-comment);
      font-style: italic;
    }
    
    /* JSX/HTML specific */
    .ace-pane .ace_entity.ace_name.ace_tag {
      color: var(--pane-syn-tag);
    }
    
    .ace-pane .ace_entity.ace_other.ace_attribute-name {
      color: var(--pane-syn-attribute);
    }
    
    /* JSX tokens */
    .ace-pane .ace_jsx {
      color: var(--pane-syn-identity);
    }
    
    .ace-pane .ace_jsx .ace_tag {
      color: var(--pane-syn-tag);
    }
    
    .ace-pane .ace_jsx .ace_attribute-name {
      color: var(--pane-syn-attribute);
    }
    
    .ace-pane .ace_jsx .ace_string {
      color: var(--pane-syn-data);
    }
    
    /* Error and invalid tokens */
    .ace-pane .ace_invalid {
      background-color: var(--pane-error-bg);
      color: var(--pane-error);
    }
    
    /* Editor UI elements */
    .ace-pane .ace_fold {
      background-color: transparent;
      border-color: var(--pane-border);
    }
    
    .ace-pane .ace_marker-layer .ace_selection {
      background: var(--pane-editor-selection);
    }
    
    .ace-pane .ace_marker-layer .ace_active-line {
      background: var(--pane-editor-active-line);
    }
    
    .ace-pane .ace_gutter-active-line {
      background-color: var(--pane-editor-active-line);
    }
    
    .ace-pane .ace_marker-layer .ace_selected-word {
      background: var(--pane-editor-search-match);
      border: 1px solid var(--pane-editor-search-match-border);
    }
    
    .ace-pane .ace_indent-guide {
      background: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAE0lEQVQImWP4////f4bLly//BwAmVgd1/w11/gAAAABJRU5ErkJggg==") right repeat-y;
    }
  `;

  var dom = require("../lib/dom");
  dom.importCssString(exports.cssText, exports.cssClass, false);
  console.log('[ACE Theme] Custom Pane theme CSS imported');

});

(function() {
  console.log('[ACE Theme] Requiring ace/theme/pane');
  ace.require(["ace/theme/pane"], function(m) {
    console.log('[ACE Theme] Custom Pane theme required:', m);
    if (typeof module == "object" && typeof exports == "object" && module) {
      module.exports = m;
    }
  });
})();
