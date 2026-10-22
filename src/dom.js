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

/**
 * Guard a control: it keeps keyboard focus (`aria-disabled`, not `disabled`)
 * and says why it cannot act yet, on hover, on focus and on press. A null
 * reason lifts the guard and restores the control's own title.
 */
export function setGuard(node, reason) {
  if (!node) return;
  if (!('baseTitle' in node.dataset)) node.dataset.baseTitle = node.getAttribute('title') ?? '';
  if (reason) {
    node.setAttribute('aria-disabled', 'true');
    node.dataset.reason = reason;
    node.setAttribute('title', reason);
  } else {
    node.removeAttribute('aria-disabled');
    delete node.dataset.reason;
    if (node.dataset.baseTitle) node.setAttribute('title', node.dataset.baseTitle);
    else node.removeAttribute('title');
  }
}

export function isGuarded(node) {
  return node?.getAttribute('aria-disabled') === 'true';
}

/**
 * A line under a row of controls that shows the hovered, focused or pressed
 * control's reason; the controls name it with aria-describedby so a screen
 * reader hears it with the control. `announce(node)` shows it on a press.
 */
export function reasonStrip(nodes, id) {
  const strip = el('p', { class: 'hint reason hidden', id, 'aria-live': 'polite' });
  const show = (n) => {
    const reason = n.dataset.reason ?? '';
    strip.textContent = reason;
    strip.classList.toggle('hidden', !reason);
  };
  const clear = () => {
    strip.textContent = '';
    strip.classList.add('hidden');
  };
  for (const n of nodes) {
    n.setAttribute('aria-describedby', id);
    n.addEventListener('mouseenter', () => show(n));
    n.addEventListener('focus', () => show(n));
    n.addEventListener('mouseleave', clear);
    n.addEventListener('blur', clear);
  }
  return Object.assign(strip, { announce: show });
}

/** Wrap a click handler so a guarded control shows its reason instead of acting. */
export function guarded(node, handler) {
  return (...args) => {
    if (isGuarded(node)) {
      const strip = document.getElementById(node.getAttribute('aria-describedby') ?? '');
      strip?.announce?.(node);
      return undefined;
    }
    return handler(...args);
  };
}
