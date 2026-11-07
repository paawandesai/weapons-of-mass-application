/**
 * Browser-side form scanner. It is a string, not a function, so the TypeScript toolchain cannot
 * rewrite it (worker tsconfig has no DOM lib, and bundlers inject helpers into serialized
 * functions). Playwright evaluates the string to a function and calls it with the ScanConfig.
 */
export const SCAN_SCRIPT = `(cfg) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const root = document.querySelector(cfg.rootSel) || document;
  const skip = (c) =>
    c.disabled ||
    ['hidden', 'submit', 'button', 'reset', 'image'].includes(c.type) ||
    c.closest(cfg.ignoreSel);
  const optionText = (input) => {
    const label =
      (input.id && root.querySelector('label[for="' + input.id + '"]')) || input.closest('label');
    return norm(label ? label.textContent : input.value);
  };
  const out = [];
  Array.from(root.querySelectorAll(cfg.fieldSel)).forEach((box) => {
    const controls = Array.from(box.querySelectorAll(cfg.controlSel)).filter((c) => !skip(c));
    if (!controls.length) return;
    const first = controls[0];
    const labelEl = box.querySelector(cfg.labelSel);
    let label = '';
    let marked = false;
    if (labelEl) {
      const clone = labelEl.cloneNode(true);
      Array.from(clone.querySelectorAll(cfg.requiredMarkSel)).forEach((m) => { marked = true; m.remove(); });
      Array.from(clone.querySelectorAll('input, select, textarea')).forEach((m) => m.remove());
      label = norm(clone.textContent);
    }
    const tag = first.tagName.toLowerCase();
    let type = 'text';
    if (tag === 'textarea') type = 'textarea';
    else if (tag === 'select') type = 'select';
    else if (first.type === 'file') type = 'file';
    else if (first.type === 'radio') type = 'radio';
    else if (first.type === 'checkbox') type = 'checkbox';
    else if (first.type === 'date') type = 'date';
    else if (first.type === 'number') type = 'number';
    const group = (type === 'radio' || type === 'checkbox') && controls.length > 1;
    let options;
    if (type === 'select') {
      options = Array.from(first.options).filter((o) => o.value !== '').map((o) => norm(o.textContent));
    } else if (group || type === 'radio') {
      options = controls.map(optionText);
    }
    const required =
      marked ||
      controls.some((c) => c.required || c.getAttribute('aria-required') === 'true');
    const section = box.closest(cfg.sectionSel);
    const heading = section ? section.querySelector('h1, h2, h3, h4, legend') : null;
    const step = box.closest('[data-step]');
    out.push({
      id: type === 'radio' || group ? first.name : first.id || first.name,
      label,
      type,
      required,
      maxLength: first.maxLength > 0 ? first.maxLength : null,
      options,
      hint: norm(
        [section && section.id, section && section.className, heading && heading.textContent, first.name, first.id].join(' '),
      ),
      step: step ? Number(step.getAttribute('data-step')) : null,
    });
  });
  return out;
}`;
