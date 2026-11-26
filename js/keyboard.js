// Built-in on-screen keyboard for the kiosk. Inputs are readonly + inputmode="none" so the
// Android/Chrome keyboard never opens; all typing goes through this component.
(function () {
  const kbd = document.getElementById('kbd');
  if (!kbd) return;

  const LAYOUT_TEXT = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['shift','z','x','c','v','b','n','m','back'],
    ['@','.','space','-','_','done']
  ];
  const LAYOUT_NUM = [
    ['1','2','3'],
    ['4','5','6'],
    ['7','8','9'],
    ['back','0','done'],
  ];

  const backIcon = '<svg viewBox="0 0 24 24"><path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7 6-7z"/><path d="M12 10l4 4m0-4l-4 4"/></svg>';
  const shiftIcon = '<svg viewBox="0 0 24 24"><path d="M12 4l8 9h-5v7H9v-7H4l8-9z"/></svg>';

  let target = null;
  let shift = false;

  function build(layout, numeric) {
    kbd.innerHTML = '';
    kbd.classList.toggle('numeric', numeric);
    layout.forEach(row => {
      const r = document.createElement('div'); r.className = 'row';
      row.forEach(k => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'key'; b.dataset.k = k;
        if (k === 'back') { b.classList.add('wide'); b.innerHTML = backIcon; }
        else if (k === 'shift') { b.classList.add('wide', 'shift'); b.innerHTML = shiftIcon; }
        else if (k === 'space') { b.classList.add('space'); b.textContent = ''; }
        else if (k === 'done') { b.classList.add('done'); b.textContent = 'DONE'; }
        else b.textContent = k;
        r.appendChild(b);
      });
      kbd.appendChild(r);
    });
    applyShift();
  }

  function applyShift() {
    kbd.querySelectorAll('.key').forEach(b => {
      const k = b.dataset.k;
      if (k.length === 1 && /[a-z]/i.test(k)) b.textContent = shift ? k.toUpperCase() : k.toLowerCase();
      if (k === 'shift') b.classList.toggle('on', shift);
    });
  }

  function setValue(v) {
    if (!target) return;
    target.value = v;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function press(k) {
    if (!target) return;
    if (k === 'back') { setValue(target.value.slice(0, -1)); return; }
    if (k === 'shift') { shift = !shift; applyShift(); return; }
    if (k === 'done') { const t = target; hide(); t.dispatchEvent(new CustomEvent('kbd:done', { bubbles: true })); return; }
    if (k === 'space') k = ' ';
    const max = parseInt(target.getAttribute('maxlength') || '0', 10);
    if (max && target.value.length >= max) return;
    let ch = k;
    if (/[a-z]/i.test(ch)) {
      ch = shift ? ch.toUpperCase() : ch.toLowerCase();
      // Auto-capitalise first letter of each word in name fields.
      if (target.dataset.caps === 'words' && (target.value === '' || target.value.endsWith(' '))) ch = ch.toUpperCase();
    }
    setValue(target.value + ch);
    if (shift && k.length === 1) { shift = false; applyShift(); }
  }

  kbd.addEventListener('pointerdown', e => {
    const b = e.target.closest('.key'); if (!b) return;
    e.preventDefault();
    b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 120);
    press(b.dataset.k);
  });

  function show(input) {
    target = input;
    const numeric = input.getAttribute('inputmode') === 'tel' || input.dataset.kbd === 'numeric';
    build(numeric ? LAYOUT_NUM : LAYOUT_TEXT, numeric);
    shift = input.dataset.caps === 'words' && input.value === '';
    applyShift();
    kbd.classList.add('show');
    document.querySelectorAll('input.active').forEach(i => i.classList.remove('active'));
    input.classList.add('active');
    document.body.classList.add('kbd-open');
  }
  function hide() {
    kbd.classList.remove('show');
    document.querySelectorAll('input.active').forEach(i => i.classList.remove('active'));
    document.body.classList.remove('kbd-open');
    target = null;
  }

  document.querySelectorAll('input[data-kbd]').forEach(inp => {
    inp.setAttribute('readonly', 'readonly');
    inp.setAttribute('inputmode', inp.getAttribute('inputmode') || 'none');
    inp.addEventListener('pointerdown', e => { e.preventDefault(); show(inp); });
    inp.addEventListener('focus', () => show(inp));
  });

  // Tap outside inputs and keyboard closes it.
  document.addEventListener('pointerdown', e => {
    if (e.target.closest('#kbd') || e.target.closest('input[data-kbd]')) return;
    if (kbd.classList.contains('show')) hide();
  });

  window.KioskKeyboard = { show, hide };
})();
