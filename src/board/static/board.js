/*
 * Optional script: sends a form in the background, fetches the page again and
 * swaps in the sections that changed. Without it every form still posts normally.
 * It holds no data and no logic of its own, and talks only to the board itself.
 */
(() => {
  'use strict';

  const SELECT_SUBMIT = 'button[type="submit"], button:not([type]), input[type="submit"]';

  const supported = () =>
    typeof fetch === 'function' &&
    typeof DOMParser === 'function' &&
    typeof FormData === 'function' &&
    typeof URLSearchParams === 'function';

  const submitButtons = (form) => Array.from(form.querySelectorAll(SELECT_SUBMIT));

  const setBusy = (form, busy) => {
    if (busy) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
    submitButtons(form).forEach((b) => {
      b.disabled = busy;
    });
  };

  const readMessage = (form) => {
    const next = form.nextElementSibling;
    return next && next.hasAttribute('data-message') ? next : null;
  };

  const clearMessage = (form) => {
    const el = readMessage(form);
    if (el) el.remove();
  };

  const showMessage = (form, text) => {
    let el = readMessage(form);
    if (!el) {
      el = document.createElement('p');
      el.setAttribute('data-message', '');
      form.after(el);
    }
    el.textContent = text;
  };

  const sectionsOf = (root) => {
    const out = new Map();
    root.querySelectorAll('[data-section]').forEach((el) => {
      const name = el.getAttribute('data-section');
      if (!out.has(name)) out.set(name, el);
    });
    return out;
  };

  const firstField = (section) =>
    section.querySelector('input[type="text"], input:not([type]), textarea');

  const isBeingTyped = (section) => {
    const active = document.activeElement;
    if (active && section.contains(active)) return true;
    const field = firstField(section);
    return Boolean(field && field.value);
  };

  const takeOverRules = (rules) => {
    const live = document.querySelector('head style');
    if (live && rules && live.textContent !== rules) {
      live.textContent = rules;
    }
  };

  const swapSections = (fetched, rules, wasIdea) => {
    takeOverRules(rules);
    const current = sectionsOf(document);
    const fresh = sectionsOf(fetched);
    let anchor = null;
    let changedCapture = null;

    fresh.forEach((freshNode, name) => {
      const live = current.get(name);
      if (live) {
        const keep = name === 'capture' && !wasIdea && isBeingTyped(live);
        if (!keep && live.outerHTML !== freshNode.outerHTML) {
          const copy = document.importNode(freshNode, true);
          live.replaceWith(copy);
          if (name === 'capture') changedCapture = copy;
          anchor = copy;
        } else {
          anchor = live;
        }
        return;
      }
      const copy = document.importNode(freshNode, true);
      if (anchor) {
        anchor.after(copy);
      } else {
        let following = null;
        let seen = false;
        fresh.forEach((_node, other) => {
          if (other === name) seen = true;
          else if (seen && !following && current.has(other)) following = current.get(other);
        });
        if (following) {
          following.before(copy);
        } else {
          const any = current.values().next().value;
          if (any && any.parentNode) any.parentNode.appendChild(copy);
        }
      }
      anchor = copy;
    });

    current.forEach((live, name) => {
      if (!fresh.has(name)) live.remove();
    });

    if (wasIdea) {
      const capture = changedCapture || sectionsOf(document).get('capture');
      const field = capture ? firstField(capture) : null;
      if (field) field.focus();
    }
  };

  /* Takes the answer that carries the page (the one read of R108) and swaps it in. */
  const showPage = (res, wasIdea) => {
    if (!res.ok) {
      window.location.reload();
      return Promise.resolve();
    }
    return res.text().then((text) => {
      /* The style block is cut out of the text before parsing: parsed inside the
         fetched page it carries another page's nonce and raises a policy warning. */
      const found = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(text);
      const rules = found ? found[1] : '';
      const bare = found ? text.replace(found[0], '') : text;
      const fetched = new DOMParser().parseFromString(bare, 'text/html');
      /* A page with no section (a login page, a notice) is not a board page: swapping
         it in would remove every live section, so the window is reloaded instead. */
      if (fetched.querySelectorAll('[data-section]').length === 0) {
        window.location.reload();
        return;
      }
      swapSections(fetched, rules, wasIdea);
    });
  };

  const refresh = (wasIdea) =>
    fetch('/', { credentials: 'same-origin', cache: 'no-store' }).then((res) =>
      showPage(res, wasIdea),
    );

  const failureText = (text) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const marked = doc.querySelector('[data-message]');
    const raw = marked ? marked.textContent : doc.body ? doc.body.textContent : '';
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  };

  const onSubmit = (ev) => {
    const form = ev.target;
    if (!form || form.tagName !== 'FORM' || ev.defaultPrevented || !supported()) return;

    let body;
    let wasIdea;
    try {
      let data;
      try {
        data = new FormData(form, ev.submitter || undefined);
      } catch (_e) {
        data = new FormData(form);
      }
      body = new URLSearchParams(data);
      wasIdea = Boolean(form.closest('[data-section="capture"]'));
    } catch (_e) {
      return;
    }

    ev.preventDefault();
    clearMessage(form);
    setBusy(form, true);

    fetch(form.action, {
      method: 'POST',
      body,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).then(
      (res) => {
        /* A followed redirect already is the one read of the page (R108): use it. */
        if (res.redirected || res.ok) {
          return (res.redirected ? showPage(res, wasIdea) : refresh(wasIdea))
            .then(() => setBusy(form, false))
            .catch(() => {
              setBusy(form, false);
              window.location.reload();
            });
        }
        return res.text().then((text) => {
          showMessage(form, failureText(text));
          setBusy(form, false);
        });
      },
      () => {
        setBusy(form, false);
        form.submit();
      },
    );
  };

  document.addEventListener('submit', (ev) => {
    try {
      onSubmit(ev);
    } catch (_e) {
      /* any surprise: let the normal submit happen */
      if (ev.defaultPrevented && ev.target && typeof ev.target.submit === 'function') {
        ev.target.removeAttribute('aria-busy');
        ev.target.submit();
      }
    }
  });
})();
