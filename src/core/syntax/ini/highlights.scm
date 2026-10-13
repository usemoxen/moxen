; Query from: https://github.com/justinmk/tree-sitter-ini/blob/v1.4.0/queries/highlights.scm
(section_name
  (text) @type) ; consistency with toml

(comment) @comment @spell

[
  "["
  "]"
] @punctuation.bracket

"=" @operator

(setting
  (setting_name) @property)

; (setting_value) @none ; grammar does not support subtypes
