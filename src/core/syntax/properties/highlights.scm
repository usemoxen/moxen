; Query from: https://github.com/tree-sitter-grammars/tree-sitter-properties/blob/v0.3.0/queries/highlights.scm
(comment) @comment

(key) @property

(value) @string

(value (escape) @string.escape)

((index) @number
  (#match? @number "^[0-9]+$"))

((substitution (key) @constant)
  (#match? @constant "^[A-Z0-9_]+"))

(substitution
  (key) @function
  "::" @punctuation.special
  (secret) @embedded)

(property [ "=" ":" ] @operator)

[ "${" "}" ] @punctuation.special

(substitution ":" @punctuation.special)

[ "[" "]" ] @punctuation.bracket

[ "." "\\" ] @punctuation.delimiter
