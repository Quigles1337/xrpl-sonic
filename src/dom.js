// xrpl-sonic — tiny DOM helpers shared by the UI modules.

/** Create an element. `class`, `text` and `html` are special; `onxxx` functions become listeners; true sets a bare attribute. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export function option(value, label, selected) {
  return el('option', { value, text: label, selected: selected ? true : false });
}

/** Build an element from trusted SVG markup (the icons in src/glyphs.js contain no caller input). */
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild;
}
