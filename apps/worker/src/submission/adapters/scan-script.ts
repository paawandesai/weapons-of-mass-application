/**
 * Browser-side scripts of the generic form layer. They are strings, not functions, so the
 * TypeScript toolchain cannot rewrite them (the worker tsconfig has no DOM lib, and bundlers inject
 * helpers into serialized functions). Playwright evaluates each string to a function and calls it.
 * They are written as `String.raw` templates: the page code below must contain no backtick and no
 * dollar-brace sequence.
 *
 * SCAN_SCRIPT reads the accessibility semantics of the page (design rules 1-6 of
 * docs/design/wave5-generic-submitter.md) and stamps what it found so Playwright can act on it:
 *   data-wma-c="<n>"       every control of a question, unique per scan
 *   data-wma-root          the form root
 *   data-wma-nav="..."     the submit button and the step buttons
 */
export const SCAN_SCRIPT = String.raw`(opts) => {
  const doc = document;
  const win = window;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const low = (s) => norm(s).toLowerCase();
  const attr = (el, name) => (el.getAttribute ? el.getAttribute(name) : null);
  const klass = (el) => (el.getAttribute ? el.getAttribute('class') || '' : '');
  const each = (list, fn) => Array.prototype.forEach.call(list, fn);
  const arr = (list) => Array.prototype.slice.call(list);

  each(doc.querySelectorAll('[data-wma-c],[data-wma-root],[data-wma-nav],[data-wma-o],[data-wma-old]'), (e) => {
    e.removeAttribute('data-wma-c');
    e.removeAttribute('data-wma-root');
    e.removeAttribute('data-wma-nav');
  });

  const SKIP_SEL =
    '#captcha-widget,.captcha-widget,[data-captcha],.h-captcha,.g-recaptcha,.grecaptcha-badge,[data-sitekey],' +
    '#account_form,.ashby-auth-form,nav,[role=banner],[role=navigation],[role=search],[class*=autofill]';
  const POPUP_SEL = '[role=dialog],[role=alertdialog],[role=listbox],[role=menu],.iti__dropdown-content';
  const CTL =
    'input,select,textarea,[role=combobox],[role=listbox],[role=radio],[role=checkbox],[role=switch],' +
    'button[aria-pressed],button[data-option],[contenteditable]';
  const NOT_INPUT_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'password'];
  const SUBMIT_TEXT = /^(submit( application)?|apply( now)?|send application)$/i;
  const ACTION_TEXT = /^(attach|upload( file)?|choose file|browse( files)?|select file|enter manually|drop (your|a) file.*)$/i;
  const RESUME_RE = /resume|\bcv\b|curriculum/i;
  const HEADING_SEL =
    'h1,h2,h3,h4,h5,h6,[role=heading],legend,[class*="section-header"],[class*="sectionHeader"],[class*="section-title"],[class*="SectionHeader"]';
  const NEXT_RE = /^(next|continue|next step)$/i;
  const BACK_RE = /^(back|previous)$/i;

  let uidCounter = 0;
  const uids = new Map();
  const uid = (el) => {
    if (!uids.has(el)) uids.set(el, ++uidCounter);
    return uids.get(el);
  };

  // ---- visibility and skipping -------------------------------------------------------------
  const isStep = (a) => a.hasAttribute && a.hasAttribute('data-step');
  const visible = (el) => {
    let stepHidden = false;
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const cs = win.getComputedStyle(a);
      if (a.hidden || cs.display === 'none' || (a === el && cs.visibility === 'hidden')) {
        if (a !== el && isStep(a)) stepHidden = true;
        else return false;
      }
    }
    if (stepHidden) return true;
    return el.getClientRects().length > 0;
  };
  const isHeader = (a) => a.tagName === 'HEADER' && !(a.parentElement && a.parentElement.closest('form,main,section,article'));
  function skipped(el, root, noPopup) {
    if (el.matches(SKIP_SEL)) return true;
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (a.matches(SKIP_SEL) || isHeader(a)) return true;
      if (attr(a, 'aria-hidden') === 'true') return true;
      if (!noPopup && a.matches(POPUP_SEL)) return true;
      if (a.tagName === 'FORM' && a.querySelector('input[type=password]')) return true;
      if (a === root) break;
    }
    return attr(el, 'aria-hidden') === 'true';
  }

  // ---- text helpers ------------------------------------------------------------------------
  const BLOCK_SKIP = { SCRIPT: 1, STYLE: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1, NOSCRIPT: 1, INPUT: 1 };
  function textOf(node, o) {
    o = o || {};
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      if (BLOCK_SKIP[n.tagName]) return;
      if (o.noButtons && n.tagName === 'BUTTON') return;
      if (n.hidden) return;
      const block = !/^inline/.test(win.getComputedStyle(n).display || 'inline');
      if (block) out += ' ';
      for (let ch = n.firstChild; ch; ch = ch.nextSibling) walk(ch);
      if (block) out += ' ';
    })(node);
    return norm(out);
  }
  const rawTextOf = (node) => {
    // The label text before normalisation: only the end matters (a trailing asterisk).
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1 || BLOCK_SKIP[n.tagName] || n.hidden) return;
      for (let ch = n.firstChild; ch; ch = ch.nextSibling) walk(ch);
    })(node);
    return out;
  };
  function wrapLabelText(label, c) {
    let ch = c;
    while (ch && ch.parentElement !== label) ch = ch.parentElement;
    if (!ch) return textOf(label);
    let before = '';
    for (let s = label.firstChild; s && s !== ch; s = s.nextSibling) {
      before += ' ' + (s.nodeType === 3 ? s.nodeValue : s.nodeType === 1 ? textOf(s) : '');
    }
    before = norm(before);
    if (before) return before;
    let after = '';
    for (let s = ch.nextSibling; s; s = s.nextSibling) {
      after += ' ' + (s.nodeType === 3 ? s.nodeValue : s.nodeType === 1 ? textOf(s) : '');
    }
    return norm(after);
  }
  const labelsOf = (c) => (c.labels ? arr(c.labels) : c.closest && c.closest('label') ? [c.closest('label')] : []);
  const cleanLabel = (s) => {
    let t = norm(s);
    for (let i = 0; i < 4; i++) {
      const next = t.replace(/\s*(\*|✱|\(required\)|\(optional\))+\s*$/i, '');
      if (next === t) break;
      t = next;
    }
    return t;
  };
  const idsText = (value) =>
    norm(
      String(value || '')
        .split(/\s+/)
        .map((id) => {
          const t = id ? doc.getElementById(id) : null;
          return t ? textOf(t) : '';
        })
        .join(' '),
    );

  // ---- controls ----------------------------------------------------------------------------
  const kindOfInput = (c) => {
    const tag = c.tagName.toLowerCase();
    const type = (c.type || '').toLowerCase();
    const role = low(attr(c, 'role'));
    if (tag === 'input' && type === 'file') return 'file';
    if (tag === 'textarea' || (c.isContentEditable && tag !== 'input')) return 'textarea';
    if (tag === 'select') return 'select';
    if (role === 'combobox') return 'combobox';
    if (tag === 'input' && (low(attr(c, 'aria-autocomplete')) === 'list' || /^(true|listbox|menu|grid|tree)$/.test(low(attr(c, 'aria-haspopup'))))) {
      return 'combobox';
    }
    if (role === 'listbox') return 'listbox';
    if (type === 'radio' || role === 'radio') return 'radio';
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox';
    if (tag === 'button' || role === 'button') return 'pressed';
    if (tag === 'input') {
      const dateish = /(^|[^a-z])date($|[^a-z])|datepicker/i;
      if (type === 'date') return 'date';
      if (['text', '', 'search', 'email', 'tel', 'url', 'number'].indexOf(type) >= 0) {
        if ((type === 'text' || type === '' || type === 'search') && (dateish.test(klass(c)) || dateish.test(attr(c, 'placeholder') || ''))) return 'date';
        return type === 'search' || type === '' ? 'text' : type;
      }
      return 'unknown';
    }
    return 'unknown';
  };

  function collectControls(root, noRoot) {
    const out = [];
    each(root.querySelectorAll(CTL), (c) => {
      const tag = c.tagName.toLowerCase();
      if (tag === 'input' && NOT_INPUT_TYPES.indexOf((c.type || '').toLowerCase()) >= 0) return;
      if (c.disabled) return;
      if (attr(c, 'contenteditable') === 'false') return;
      if (skipped(c, root, false)) return;
      const isFile = tag === 'input' && c.type === 'file';
      if (!isFile && !visible(c)) return;
      // The backing checkbox of a pressed-button pair belongs to the buttons.
      if (tag === 'input' && c.type === 'checkbox' && c.parentElement && c.parentElement.querySelector('[data-option],button[aria-pressed]')) return;
      out.push(c);
    });
    return out.filter(
      (c) => !out.some((d) => d !== c && d.contains(c) && (attr(d, 'role') === 'combobox' || attr(d, 'role') === 'listbox' || d.isContentEditable)),
    );
  }

  // ---- the form root (rule 1) --------------------------------------------------------------
  const lca = (els) => {
    let a = els[0];
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a;
  };
  const depth = (el) => {
    let n = 0;
    for (let a = el; a; a = a.parentElement) n++;
    return n;
  };
  const matchesResume = (c) =>
    RESUME_RE.test([attr(c, 'name'), c.id, attr(c, 'accept'), labelsOf(c).map((l) => textOf(l)).join(' ')].join(' '));
  const files = arr(doc.querySelectorAll('input[type=file]')).filter((c) => !c.disabled && !skipped(c, doc.body, true));
  let resumeInput = files.filter(matchesResume)[0] || files[0] || null;

  const btnText = (b) => norm(b.tagName === 'INPUT' ? b.value : textOf(b)) || norm(attr(b, 'aria-label'));
  const allButtons = arr(doc.querySelectorAll('button,input[type=submit]')).filter(
    (b) => !skipped(b, doc.body, true) && visible(b) && btnText(b),
  );
  const explicitSubmits = allButtons.filter((b) => (b.tagName === 'INPUT' ? b.type === 'submit' : attr(b, 'type') === 'submit'));
  const submitCandidates = explicitSubmits.length ? explicitSubmits : allButtons.filter((b) => b.tagName === 'BUTTON' && SUBMIT_TEXT.test(btnText(b)));

  let anchor = resumeInput;
  if (!anchor) {
    anchor =
      arr(doc.querySelectorAll('input')).filter((c) => {
        const t = (c.type || 'text').toLowerCase();
        return ['text', 'email', 'tel', 'url', 'number', 'search'].indexOf(t) >= 0 && !c.disabled && !skipped(c, doc.body, true) && visible(c);
      })[0] || null;
  }
  let submitBtn = null;
  if (submitCandidates.length) {
    if (anchor) {
      let best = -1;
      submitCandidates.forEach((b) => {
        const a = lca([anchor, b]);
        const d = a ? depth(a) : -1;
        if (d >= best) {
          best = d;
          submitBtn = b;
        }
      });
    } else {
      submitBtn = submitCandidates[submitCandidates.length - 1];
    }
  }

  let root = anchor && submitBtn ? lca([anchor, submitBtn]) : null;
  if (!root || root === doc.documentElement) root = null;
  if (!root) {
    root =
      arr(doc.forms).filter((f) => collectControls(f).length > 0)[0] || doc.body;
  }
  root.setAttribute('data-wma-root', '');

  const controls = collectControls(root);
  const controlSet = new Set(controls);
  if (resumeInput && !root.contains(resumeInput)) resumeInput = null;
  const rootFiles = controls.filter((c) => c.type === 'file');
  resumeInput = rootFiles.filter(matchesResume)[0] || (root.contains(resumeInput || doc.body) ? resumeInput : null) || rootFiles[0] || null;

  const owned = new Set();
  controls.forEach((c) => labelsOf(c).forEach((l) => owned.add(l)));

  // ---- clustering controls into questions (rule 3) -----------------------------------------
  const sameNameCheckboxes = (name) => controls.filter((x) => x.type === 'checkbox' && attr(x, 'name') === name).length;
  const checkboxesIn = (g) => controls.filter((x) => (x.type === 'checkbox' || attr(x, 'role') === 'checkbox') && g.contains(x)).length;
  const clusters = [];
  const byKey = new Map();
  controls.forEach((c) => {
    const kind = kindOfInput(c);
    let key = 's:' + uid(c);
    let fam = null;
    if (kind === 'radio') {
      fam = 'radio';
      const name = attr(c, 'name');
      const g = c.closest('[role=radiogroup],fieldset,[role=group]');
      key = name ? 'r:' + name : 'rg:' + uid(g || c.parentElement);
    } else if (kind === 'checkbox') {
      fam = 'checkbox';
      const name = attr(c, 'name');
      const g = c.closest('fieldset,[role=group]');
      if (name && sameNameCheckboxes(name) > 1) key = 'c:' + name;
      else if (g && checkboxesIn(g) > 1) key = 'cg:' + uid(g);
    } else if (kind === 'pressed') {
      fam = 'pressed';
      key = 'p:' + uid(c.parentElement);
    }
    if (!byKey.has(key)) {
      const cl = { key, fam, kind, members: [] };
      byKey.set(key, cl);
      clusters.push(cl);
    }
    byKey.get(key).members.push(c);
  });

  // ---- question labels and boxes (rules 3, 4) ----------------------------------------------
  const hasForeign = (a, memberSet) => controls.some((x) => !memberSet.has(x) && a.contains(x));
  const excludedEl = (p) =>
    BLOCK_SKIP[p.tagName] ||
    p.tagName === 'BUTTON' ||
    p.tagName === 'A' ||
    p.hidden ||
    (p.tagName === 'LABEL' && owned.has(p)) ||
    p.matches('[aria-live],[class*=placeholder],.iti__a11y-text,[role=log],[role=status]');
  function firstTextBefore(a, first) {
    const tw = doc.createTreeWalker(a, 4);
    let n;
    while ((n = tw.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      if (first.compareDocumentPosition(n) & 4) break;
      let bad = false;
      for (let p = n.parentElement; p; p = p.parentElement) {
        if (excludedEl(p)) {
          bad = true;
          break;
        }
        if (p === a) break;
      }
      if (bad) continue;
      let e = n.parentElement;
      while (e !== a && e.parentElement && !controls.some((x) => e.parentElement.contains(x))) e = e.parentElement;
      const t = textOf(e, { noButtons: true });
      if (t) return { text: t, raw: rawTextOf(e), el: e, box: a };
    }
    return null;
  }
  function ascend(members, memberSet) {
    let a = members.length > 1 ? lca(members) : members[0].parentElement;
    while (a && root.contains(a)) {
      if (hasForeign(a, memberSet)) return null;
      const r = firstTextBefore(a, members[0]);
      if (r) return r;
      if (a === root) return null;
      a = a.parentElement;
    }
    return null;
  }
  function groupLabelled(members, memberSet) {
    for (let a = members[0].parentElement; a && root.contains(a); a = a.parentElement) {
      if (hasForeign(a, memberSet)) return null;
      if (a.matches('[role=group],[role=radiogroup],fieldset')) {
        const t = idsText(attr(a, 'aria-labelledby')) || norm(attr(a, 'aria-label'));
        if (t) return { text: t, raw: t, el: a, box: a };
      }
      if (a === root) return null;
    }
    return null;
  }
  function closestBox(a, b) {
    if (!b) return a.parentElement;
    return lca([a, b]) || a.parentElement;
  }

  // ---- option labels (rule 5) --------------------------------------------------------------
  function optionLabel(c) {
    const ls = labelsOf(c);
    for (let i = 0; i < ls.length; i++) {
      const t = ls[i].contains(c) ? wrapLabelText(ls[i], c) : textOf(ls[i]);
      if (t) return t;
    }
    const al = norm(attr(c, 'aria-label'));
    if (al) return al;
    const lb = idsText(attr(c, 'aria-labelledby'));
    if (lb) return lb;
    if (c.tagName !== 'INPUT') {
      const t = textOf(c);
      if (t) return t;
    }
    if (c.value && c.value !== 'on') return norm(c.value);
    return '';
  }

  // ---- reading and sectioning --------------------------------------------------------------
  // A checked input, or an ARIA toggle: a button has a type property but no checked state.
  const isOn = (x) =>
    x.tagName === 'INPUT' ? !!x.checked : attr(x, 'aria-checked') === 'true' || attr(x, 'aria-pressed') === 'true';
  // The widest ancestor that holds this control and no other question's control: the control's own
  // shell (a react-select container), where its selected value lives.
  const ownShell = (c) => {
    let best = c;
    for (let a = c.parentElement; a && a !== doc.body && root.contains(a); a = a.parentElement) {
      if (controls.some((x) => x !== c && a.contains(x))) break;
      best = a;
    }
    return best;
  };
  const SINGLE_SEL = '[class*="single-value" i],[class*="singleValue" i],[class*="SingleValue"]';
  // Actual hidden state: a backing input a person cannot see (rule 6), whatever way it is hidden.
  const hiddenTwin = (x) => {
    if ((x.type || '').toLowerCase() === 'hidden' || x.hidden) return true;
    if (attr(x, 'aria-hidden') === 'true' || attr(x, 'tabindex') === '-1') return true;
    const cs = win.getComputedStyle(x);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
    const r = x.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return true;
    for (let a = x.parentElement; a && a !== doc.body; a = a.parentElement) {
      if (a.hidden || win.getComputedStyle(a).display === 'none') return true;
    }
    return false;
  };
  function currentOf(kind, members) {
    const c = members[0];
    if (kind === 'checkbox') return isOn(c);
    if (kind === 'checkbox-group') return members.filter(isOn).map(optionLabel);
    if (kind === 'radio' || kind === 'yesno') {
      const m = members.filter(isOn)[0];
      return m ? optionLabel(m) : '';
    }
    if (kind === 'select') {
      const o = c.selectedOptions && c.selectedOptions[0];
      return o && o.value !== '' ? norm(o.textContent) : '';
    }
    if (kind === 'file') return c.files && c.files.length ? c.files[0].name : '';
    if (kind === 'combobox') {
      // Ownership: only this control's own shell is read, never a neighbour's selected value.
      const shell = ownShell(c);
      const sv = shell.querySelector(SINGLE_SEL);
      const twin = arr(shell.querySelectorAll('input')).filter((x) => x !== c && !controlSet.has(x) && hiddenTwin(x))[0] || null;
      if (sv && norm(sv.textContent)) return norm(sv.textContent);
      // A select-style combobox (it has a selected-value element or a hidden backing input) holds
      // a committed selection there; the text in its search box is not one.
      if (sv || twin) return twin && twin.value ? norm(twin.value) : '';
      const inner = c.tagName === 'INPUT' ? c : c.querySelector('input');
      return norm(inner ? inner.value : c.textContent);
    }
    if (kind === 'listbox') {
      const o = c.querySelector('[role=option][aria-selected=true]');
      return o ? norm(o.textContent) : '';
    }
    if (c.isContentEditable && c.tagName !== 'INPUT') return norm(c.textContent);
    return c.value === undefined ? '' : String(c.value);
  }

  function sectionOf(box) {
    const classes = [];
    for (let a = box; a && root.contains(a); a = a.parentElement) {
      classes.push(klass(a) + ' ' + (a.id || ''));
      let found = null;
      each(a.querySelectorAll(HEADING_SEL), (h) => {
        if (box.contains(h) || h.contains(box)) return;
        // a section heading sits in a block that wraps the question, not in a closed earlier block
        if (!h.parentElement || !h.parentElement.contains(box)) return;
        if (h.compareDocumentPosition(box) & 4) found = h;
      });
      if (found) return { text: textOf(found).slice(0, 200), classes: classes.slice(0, 6).join(' ') };
      if (classes.length >= 5) break;
    }
    return { text: '', classes: classes.slice(0, 5).join(' ') };
  }
  const stepOf = (c) => {
    const s = c.closest('[data-step]');
    return s && root.contains(s) ? Number(attr(s, 'data-step')) : null;
  };

  let stampCounter = 0;
  const stamp = (c) => {
    const n = ++stampCounter;
    c.setAttribute('data-wma-c', String(n));
    return n;
  };

  // ---- descriptions (rule 22) --------------------------------------------------------------
  // The text that explains a question: aria-describedby targets; else a sibling or descendant of
  // the box whose class says description, help or hint; else the box text between the label and the
  // control. Never the label itself or an option label.
  const DESC_CLASS = /description|help|hint/i;
  const DESC_MAX = 1000;
  function descriptionOf(members, memberSet, box, labelEl, finalLabel, optionLabels) {
    const first = members[0];
    const banned = new Set([low(finalLabel)]);
    (optionLabels || []).forEach((o) => banned.add(low(o)));
    const pieces = [];
    const take = (t) => {
      t = norm(t);
      if (!t || banned.has(low(t))) return;
      if (pieces.some((p) => low(p).indexOf(low(t)) >= 0)) return;
      for (let i = pieces.length - 1; i >= 0; i--) if (low(t).indexOf(low(pieces[i])) >= 0) pieces.splice(i, 1);
      pieces.push(t);
    };
    const isLabelish = (el) => !!labelEl && (labelEl === el || labelEl.contains(el) || el.contains(labelEl));
    const holdsControl = (el) => controls.some((x) => el.contains(x));
    // 1. aria-describedby (error and placeholder targets are not descriptions)
    members.forEach((m) => {
      String(attr(m, 'aria-describedby') || '')
        .split(/\s+/)
        .forEach((id) => {
          const t = id ? doc.getElementById(id) : null;
          if (!t || isLabelish(t) || holdsControl(t)) return;
          if (/(-error|-placeholder)$/i.test(id) || attr(t, 'role') === 'alert' || attr(t, 'aria-live')) return;
          take(textOf(t, { noButtons: true }));
        });
    });
    // 2. a described element near the box
    if (!pieces.length) {
      let a = box;
      for (let lvl = 0; a && lvl < 3 && root.contains(a) && a !== root; lvl++, a = a.parentElement) {
        if (hasForeign(a, memberSet)) break;
        const taken = [];
        each(a.querySelectorAll('[class]'), (el) => {
          if (!DESC_CLASS.test(klass(el)) || isLabelish(el) || holdsControl(el) || el.hidden) return;
          if (taken.some((t) => t.contains(el))) return;
          if (el.closest('label,button,[role=listbox],[role=option]')) return;
          if (el.parentElement && el.parentElement.closest('label') && owned.has(el.parentElement.closest('label'))) return;
          taken.push(el);
          take(textOf(el, { noButtons: true }));
        });
        if (pieces.length) break;
      }
    }
    // 3. the box text between the label and the control
    if (!pieces.length && labelEl && box && box.contains(labelEl) && !hasForeign(box, memberSet)) {
      const tw = doc.createTreeWalker(box, 4);
      let n;
      let acc = '';
      while ((n = tw.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        if (labelEl.contains(n) || !(labelEl.compareDocumentPosition(n) & 4)) continue;
        if (!(first.compareDocumentPosition(n) & 2)) continue;
        let bad = false;
        for (let p = n.parentElement; p && p !== box; p = p.parentElement) {
          if (excludedEl(p) || p.tagName === 'LABEL' || holdsControl(p)) {
            bad = true;
            break;
          }
        }
        if (!bad) acc += ' ' + n.nodeValue;
      }
      take(acc);
    }
    return pieces.join(' ').slice(0, DESC_MAX).trim();
  }

  const questions = [];
  const qFirst = [];
  const qBox = [];
  clusters.forEach((cl) => {
    let members = cl.members;
    let kind = cl.kind;
    const memberSet = new Set(members);
    const first = members[0];
    let options;
    let optionLabels;
    if (cl.fam === 'radio') {
      kind = 'radio';
    } else if (cl.fam === 'checkbox') {
      kind = members.length > 1 ? 'checkbox-group' : 'checkbox';
    } else if (cl.fam === 'pressed') {
      kind = members.length > 1 ? 'radio' : 'checkbox';
    }
    if (kind === 'radio' || kind === 'checkbox-group') {
      optionLabels = members.map(optionLabel);
      options = optionLabels.slice();
      if (cl.fam === 'pressed' && optionLabels.length === 2) {
        const set = optionLabels.map(low).sort().join('|');
        const dset = members.map((m) => low(attr(m, 'data-option'))).sort().join('|');
        if (set === 'no|yes' || dset === 'no|yes') {
          kind = 'yesno';
          options = ['Yes', 'No'];
        }
      }
    }

    // label (rule 4)
    let label = '';
    let labelEl = null;
    let raw = '';
    let box = null;
    const multi = kind === 'radio' || kind === 'checkbox-group' || kind === 'yesno';
    const ownLabel = () => {
      const ls = labelsOf(first).filter((l) => !l.contains(first));
      for (let i = 0; i < ls.length && !label; i++) {
        const t = textOf(ls[i]);
        if (t && !ACTION_TEXT.test(cleanLabel(t))) {
          label = t;
          labelEl = ls[i];
          raw = rawTextOf(ls[i]);
          box = closestBox(first, ls[i]);
        }
      }
      if (!label) {
        const t = idsText(attr(first, 'aria-labelledby'));
        if (t) {
          label = t;
          raw = t;
          const ref = doc.getElementById(String(attr(first, 'aria-labelledby')).split(/\s+/)[0]);
          labelEl = ref;
          box = closestBox(first, ref);
        }
      }
      if (!label) {
        const t = norm(attr(first, 'aria-label'));
        if (t) {
          label = t;
          raw = t;
          box = first.parentElement;
        }
      }
    };
    // A lone checkbox's own label is its option text: the box label wins when there is one.
    const boxFirst = multi || kind === 'checkbox';
    if (!boxFirst) ownLabel();
    if (!label) {
      const g = groupLabelled(members, memberSet);
      if (g) {
        label = g.text;
        raw = g.raw;
        labelEl = g.el;
        box = g.box;
      }
    }
    if (!label) {
      const r = ascend(members, memberSet);
      if (r && !ACTION_TEXT.test(cleanLabel(r.text))) {
        label = r.text;
        raw = r.raw;
        labelEl = r.el;
        box = r.box;
      }
    }
    if (!label && !multi) {
      if (boxFirst) ownLabel();
      const wl = labelsOf(first).filter((l) => l.contains(first))[0];
      if (!label && wl) {
        label = wrapLabelText(wl, first);
        raw = label;
        labelEl = wl;
        box = wl.parentElement;
      }
    }
    if (!label) {
      label = norm(attr(first, 'placeholder')) || norm(attr(first, 'title')) || '';
      raw = label;
    }
    if (!label && multi) label = options && options.length ? options.join(' / ') : '';
    if (!box) box = (first.closest('fieldset,[role=group]') || first.parentElement);
    const labelClean = cleanLabel(label);
    // rule 4: option labels are never the question label; a lone checkbox keeps its own text
    let finalLabel = labelClean;
    if (!finalLabel) finalLabel = norm(attr(first, 'name')) || norm(first.id) || 'Unlabelled question';

    // required (rule 6)
    let required = members.some((m) => m.required || attr(m, 'aria-required') === 'true');
    if (/(\*|✱)\s*$/.test(raw) || /\(required\)\s*$/i.test(raw)) required = true;
    if (!required && labelEl && /required/i.test(klass(labelEl))) required = true;
    if (!required && /required/i.test(klass(box))) required = true;
    if (!required) {
      const twin = arr(box.querySelectorAll('input[required]')).filter(
        (x) => !memberSet.has(x) && !controlSet.has(x) && hiddenTwin(x),
      );
      if (twin.length) required = true;
    }

    const description = descriptionOf(members, memberSet, box, labelEl, finalLabel, optionLabels);
    const section = sectionOf(box);
    const hintBits = [section.text, section.classes];
    members.forEach((m) => hintBits.push(attr(m, 'name'), m.id));
    if (kind === 'file' && !/resume|\bcv\b/i.test(finalLabel) && first === resumeInput) hintBits.push('resume');

    let largeList = false;
    if (kind === 'select') {
      options = arr(first.options).filter((o) => o.value !== '').map((o) => norm(o.textContent));
      // rule 20: a native select over the bound is described without its options, like a combobox
      if (options.length > (opts.largeList || 60)) {
        options = undefined;
        largeList = true;
      }
    }
    if (kind === 'listbox') {
      options = arr(first.querySelectorAll('[role=option]')).map((o) => norm(o.textContent));
    }

    let id;
    const nameAttr = attr(first, 'name');
    if (multi && nameAttr && cl.key.charAt(0) !== 'p') id = nameAttr;
    else id = first.id || nameAttr || '';

    const q = {
      id,
      label: finalLabel,
      kind,
      required,
      maxLength: first.maxLength > 0 ? first.maxLength : null,
      options,
      members: members.map((m, i) => ({
        ref: stamp(m),
        label: optionLabels ? optionLabels[i] : '',
        value: m.tagName === 'INPUT' || m.tagName === 'BUTTON' ? m.value || '' : '',
        dataOption: low(attr(m, 'data-option')),
      })),
      typeRef: null,
      context: norm(hintBits.join(' ')),
      step: stepOf(first),
      placeholder: attr(first, 'placeholder') || '',
      inputType: (first.type || '').toLowerCase(),
      itl: !!first.closest('[class*=iti]'),
      current: currentOf(kind, members),
      currentValue: kind === 'select' && first.selectedOptions && first.selectedOptions[0] ? first.selectedOptions[0].value : '',
      isResume: first === resumeInput,
    };
    if (largeList) q.largeList = true;
    if (description) q.description = description;
    if (kind === 'combobox' && first.tagName !== 'INPUT') {
      const inner = first.querySelector('input');
      if (inner) q.typeRef = stamp(inner);
    }
    if (kind === 'unknown') q.note = 'unknown-control';
    questions.push(q);
    qFirst.push(first);
    qBox.push(box);
  });

  // stable ids (rule 3): an anonymous control (no id, no name) is identified by its structure, not
  // by a running index, so inserting a control elsewhere does not renumber it. The path is the label
  // text, the control's tag and type, and its position among the same in its box.
  const slug = (t) => low(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const boxCounts = new Map();
  questions.forEach((q, i) => {
    if (q.id) return;
    const f = qFirst[i];
    const sig = slug(q.label) + ':' + f.tagName.toLowerCase() + (f.type ? '/' + f.type : '');
    if (!boxCounts.has(qBox[i])) boxCounts.set(qBox[i], {});
    const counts = boxCounts.get(qBox[i]);
    const pos = counts[sig] || 0;
    counts[sig] = pos + 1;
    q.id = 'q:' + sig + (pos ? '.' + pos : '');
  });
  const seen = {};
  questions.forEach((q) => {
    if (seen[q.id]) {
      seen[q.id]++;
      q.id = q.id + '~' + seen[q.id];
    } else seen[q.id] = 1;
  });

  // ---- steps and the submit button (rules 10, 12) ------------------------------------------
  const panels = arr(root.querySelectorAll('[data-step]'));
  const active = panels.filter((p) => win.getComputedStyle(p).display !== 'none' && !p.hidden)[0] || null;
  const stepInfo = { count: panels.length, active: active ? Number(attr(active, 'data-step')) : null };
  if (active) {
    each(active.querySelectorAll('button'), (b) => {
      const t = btnText(b);
      if (b === submitBtn) return;
      if (NEXT_RE.test(t) && !b.disabled) b.setAttribute('data-wma-nav', 'next');
      else if (BACK_RE.test(t)) b.setAttribute('data-wma-nav', 'back');
    });
  }
  let submit = null;
  if (submitBtn && root.contains(submitBtn)) {
    submitBtn.setAttribute('data-wma-nav', 'submit');
    const sp = submitBtn.closest('[data-step]');
    submit = {
      text: btnText(submitBtn),
      disabled: !!submitBtn.disabled || attr(submitBtn, 'aria-disabled') === 'true',
      step: sp ? Number(attr(sp, 'data-step')) : null,
    };
  }
  const resumeQ = questions.filter((q) => q.isResume)[0];
  return {
    questions,
    submit,
    resumeRef: resumeInput ? (resumeQ ? resumeQ.members[0].ref : stamp(resumeInput)) : null,
    steps: stepInfo,
    controls: controls.length,
  };
}`;

/**
 * Probe after a submit (rules 12, 13, 15): confirmation text, validation errors, CAPTCHA
 * challenges and the application-limit notice. Reads only; never stamps the page.
 */
export const PROBE_SCRIPT = String.raw`(opts) => {
  const doc = document;
  const win = window;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const arr = (list) => Array.prototype.slice.call(list);
  const attr = (el, n) => el.getAttribute(n);
  const root = doc.querySelector('[data-wma-root]');
  const shown = (el) => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const cs = win.getComputedStyle(a);
      if (a.hidden || cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return el.getClientRects().length > 0;
  };
  const inCaptcha = (el) =>
    !!el.closest('#captcha-widget,.captcha-widget,[data-captcha],.h-captcha,.g-recaptcha,.grecaptcha-badge,[data-sitekey]');
  // Native and role-based controls: a form that still shows any of them has not been replaced.
  const CTL =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea,' +
    '[role=combobox],[role=listbox],[role=radio],[role=checkbox],[role=switch],button[aria-pressed],button[data-option],' +
    '[contenteditable=""],[contenteditable=true]';
  const bodyText = doc.body ? doc.body.innerText || '' : '';

  const controlsLeft =
    !!root && doc.contains(root) && arr(root.querySelectorAll(CTL)).some((c) => shown(c) && !inCaptcha(c));
  const rootGone = !root || !doc.contains(root) || !shown(root);

  // The thank-you text counts only as evidence of THIS submission: it must have appeared after the
  // click (more occurrences than in the page text recorded before it), never boilerplate that was
  // already there.
  const count = (text, re) => {
    const m = text.match(re);
    return m ? m.length : 0;
  };
  const thanksRe = new RegExp(opts.thanks, 'ig');
  const thanksNow = count(bodyText, thanksRe);
  const thanksBefore = typeof opts.before === 'string' ? count(opts.before, thanksRe) : 0;
  const thanks = thanksNow > thanksBefore;

  // validation errors
  const errors = [];
  const push = (t) => {
    t = norm(t).slice(0, 200);
    if (t && errors.indexOf(t) < 0 && errors.length < 10) errors.push(t);
  };
  arr(doc.querySelectorAll('[aria-invalid=true]')).forEach((el) => {
    if (inCaptcha(el) || !shown(el)) return;
    const mid = attr(el, 'aria-errormessage');
    const m = mid ? doc.getElementById(mid) : null;
    const lbl = el.labels && el.labels[0] ? norm(el.labels[0].textContent) : norm(attr(el, 'aria-label') || attr(el, 'name') || el.id);
    push((lbl ? lbl + ': ' : '') + (m && norm(m.textContent) ? m.textContent : 'invalid'));
  });
  arr(doc.querySelectorAll('[role=alert]')).forEach((el) => {
    if (!inCaptcha(el) && shown(el)) push(el.textContent);
  });
  arr(doc.querySelectorAll('[class*=error i]')).forEach((el) => {
    if (inCaptcha(el) || !shown(el)) return;
    if (el.querySelector(CTL) || el.tagName === 'FORM' || el.tagName === 'BODY') return;
    const t = norm(el.textContent);
    if (t && t.length <= 300) push(t);
  });

  // CAPTCHA challenges (rule 13): iframes and site-key widgets with a visible box. A challenge
  // that was completed stays on the page, so completion is read from the response token the
  // provider writes (or from the frame being hidden, which "shown" covers).
  const tokenPresent = arr(
    doc.querySelectorAll('[name=g-recaptcha-response],[name=h-captcha-response],[name=cf-turnstile-response]'),
  ).some((f) => norm(f.value).length > 0);
  let challenge = false;
  arr(doc.querySelectorAll('iframe[src*=hcaptcha],iframe[src*=recaptcha]')).forEach((f) => {
    if (f.closest('.grecaptcha-badge')) return;
    const r = f.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && shown(f)) challenge = true;
  });
  arr(doc.querySelectorAll('[data-sitekey]')).forEach((w) => {
    if (w.closest('.grecaptcha-badge')) return;
    const r = w.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && shown(w)) challenge = true;
  });
  const frame = challenge && !tokenPresent;

  // Ashby application limits (rule 15)
  let notice = null;
  const m = /may not apply more than (\d+) times in any (\d+) day/i.exec(bodyText);
  if (m) notice = { max: Number(m[1]), days: Number(m[2]) };

  return { controlsLeft, rootGone, thanks, errors, frame, notice, bodyText: opts.wantText ? bodyText : undefined };
}`;

/**
 * Option collection for an opened combobox (rule 7). The options belong to the active control:
 * the listbox it names with aria-controls or aria-owns, else the react-select options derived from
 * its input id, else the nearest listbox that appeared after the click (menus may render in a
 * portal outside the form), else options that were not on the page before the click. Stamps each
 * with data-wma-o so Playwright can click it.
 */
export const OPTIONS_SCRIPT = String.raw`(opts) => {
  const doc = document;
  const win = window;
  const arr = (list) => Array.prototype.slice.call(list);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const cs = win.getComputedStyle(a);
      if (a.hidden || cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return el.getClientRects().length > 0;
  };
  if (opts.mark) {
    arr(doc.querySelectorAll('[data-wma-o]')).forEach((e) => e.removeAttribute('data-wma-o'));
    arr(doc.querySelectorAll('[data-wma-old]')).forEach((e) => e.removeAttribute('data-wma-old'));
    arr(doc.querySelectorAll('[role=option],[role=listbox]')).forEach((e) => {
      if (shown(e)) e.setAttribute('data-wma-old', '');
    });
    return { options: [], expanded: false };
  }
  arr(doc.querySelectorAll('[data-wma-o]')).forEach((e) => e.removeAttribute('data-wma-o'));

  const ctls = (opts.refs || [])
    .map((r) => doc.querySelector('[data-wma-c="' + r + '"]'))
    .filter((e) => !!e);
  // aria-expanded may sit on the wrapper that carries role=combobox, not on the input inside it
  const expanded = ctls.some((c) => {
    const holder = c.closest('[aria-expanded]');
    return c.getAttribute('aria-expanded') === 'true' || (!!holder && holder.getAttribute('aria-expanded') === 'true');
  });

  const found = [];
  const add = (e) => {
    if (found.indexOf(e) < 0 && shown(e)) found.push(e);
  };
  // 1. the listbox the control names
  const owned = [];
  ctls.forEach((c) => {
    const holders = [c, c.closest('[role=combobox]'), c.closest('[aria-controls],[aria-owns]')];
    holders.forEach((h) => {
      if (!h) return;
      ((h.getAttribute('aria-controls') || '') + ' ' + (h.getAttribute('aria-owns') || '')).split(/\s+/).forEach((id) => {
        const t = id ? doc.getElementById(id) : null;
        if (t && owned.indexOf(t) < 0) owned.push(t);
      });
    });
  });
  owned.forEach((t) => {
    if (t.getAttribute('role') === 'option') add(t);
    arr(t.querySelectorAll('[role=option]')).forEach(add);
  });
  // 2. react-select: option ids are <instance>-option-<n>, the instance being the input id
  //    without a trailing -input (or the id itself, as Greenhouse uses the question id)
  if (found.length === 0) {
    const prefixes = [];
    ctls.concat(ctls.map((c) => c.querySelector('input'))).forEach((c) => {
      if (!c || !c.id) return;
      const base = c.id.replace(/-input$/, '');
      prefixes.push(base.indexOf('react-select-') === 0 ? base : 'react-select-' + base);
    });
    if (opts.prefix) prefixes.push(opts.prefix);
    arr(doc.querySelectorAll('[id^="react-select-"]')).forEach((e) => {
      if (/-option-/.test(e.id) && prefixes.some((p) => e.id.indexOf(p + '-option') === 0)) add(e);
    });
  }
  // 3. the nearest listbox that appeared after the click
  if (found.length === 0) {
    const ctl = ctls[0];
    const cr = ctl ? ctl.getBoundingClientRect() : null;
    const fresh = arr(doc.querySelectorAll('[role=listbox]:not([data-wma-old])')).filter(
      (l) => shown(l) && !ctls.some((c) => l.contains(c)) && l.querySelector('[role=option]'),
    );
    fresh.sort((x, y) => {
      if (!cr) return 0;
      const dist = (e) => {
        const r = e.getBoundingClientRect();
        return Math.abs(r.left - cr.left) + Math.abs(r.top - cr.bottom);
      };
      return dist(x) - dist(y);
    });
    if (fresh[0]) arr(fresh[0].querySelectorAll('[role=option]')).forEach(add);
  }
  // 4. options that were not there before the click
  if (found.length === 0) {
    arr(doc.querySelectorAll('[role=option]:not([data-wma-old])')).forEach(add);
  }
  const out = [];
  found.forEach((e, i) => {
    const t = norm(e.textContent);
    if (!t) return;
    e.setAttribute('data-wma-o', String(i));
    out.push({ i, text: t });
  });
  return { options: out, expanded };
}`;
