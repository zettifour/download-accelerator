function switchOS(os, btn) {
  document.querySelectorAll('.os-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.os-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-' + os).classList.add('active');
}
