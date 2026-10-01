export type FormProblem = { element: HTMLElement | null; message: string };
export function notifyForm(message: string, tone: 'error' | 'success', details: string[] = []) {
  const box = document.querySelector<HTMLElement>('#form-notice');
  if (!box) return;
  box.dataset.tone = tone;
  box.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  box.querySelector('[data-notice-title]')!.textContent = message;
  box.querySelector('.notice-icon')!.textContent = tone === 'error' ? '!' : '✓';
  const list = box.querySelector('[data-notice-items]')!;
  list.replaceChildren(...details.map(message => { const item = document.createElement('li'); item.textContent = message; return item; }));
  box.hidden = false;
}

export function clearFormErrors(form: HTMLFormElement) {
  form.querySelectorAll('[aria-invalid]').forEach(control => control.removeAttribute('aria-invalid'));
  form.querySelectorAll('[aria-describedby]').forEach(control => { const remaining=control.getAttribute('aria-describedby')!.replace(/field-error-\d+/g,'').trim(); if(remaining)control.setAttribute('aria-describedby',remaining);else control.removeAttribute('aria-describedby'); });
  form.querySelectorAll('.field-invalid').forEach(note => note.remove());
}

/** Collect browser constraints ourselves so hidden native bubbles cannot swallow submission. */
export function formProblems(form: HTMLFormElement): FormProblem[] {
  const problems: FormProblem[] = [];
  const radioGroups = new Set<string>();
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(control => {
    if (control.disabled || control.type === 'hidden' || control.type === 'file' || 'readOnly' in control && control.readOnly) return;
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      if (radioGroups.has(control.name)) return;
      radioGroups.add(control.name);
    }
    const label = control.dataset.label || control.labels?.[0]?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 30) || '此项';
    let message = '';
    if (control.required && (control.validity.valueMissing || control.type !== 'radio' && control.type !== 'checkbox' && !control.value.trim())) message = `${label}：请填写或选择。`;
    else if (control instanceof HTMLInputElement && control.validity.badInput) message = `${label}：请输入有效数字。`;
    else if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && control.maxLength >= 0 && control.value.length > control.maxLength) message = `${label}：最多 ${control.maxLength} 字。`;
    else if (!control.validity.valid) message = `${label}：${control.validationMessage}`;
    if (message) problems.push({ element: control, message });
  });
  return problems;
}

export function showFormErrors(form: HTMLFormElement, problems: FormProblem[]) {
  clearFormErrors(form);
  const unique = problems.filter((problem,index) => problems.findIndex(item => problem.element ? item.element === problem.element : item.message === problem.message) === index);
  unique.forEach(({ element, message },index) => {
    if (!element) return;
    element.setAttribute('aria-invalid', 'true');
    const note = document.createElement('small'); note.className = 'field-invalid'; note.id = `field-error-${index}`; note.textContent = message;
    const container = element.closest('[data-star-rating]') || element.closest('label') || element;
    container.append(note);
    // Preserve existing hints and counts for assistive technology.
    element.setAttribute('aria-describedby', [element.getAttribute('aria-describedby')?.replace(/field-error-\d+/g, '').trim(), note.id].filter(Boolean).join(' '));
  });
  notifyForm('还有这些内容需要补全', 'error', unique.map(problem => problem.message));
  const first = unique.find(problem => problem.element)?.element;
  if (first) {
    for (let ancestor = first.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
}
