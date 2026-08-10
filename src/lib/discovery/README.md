# `lib/discovery`

Finds interactive elements on the page and tracks which ones keyboard traversal has
actually reached.

Native controls, `tabindex >= 0`, interactive ARIA roles, links with `href`. This is
what makes "unreachable interactive element" provable rather than asserted.
