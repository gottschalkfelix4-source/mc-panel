(function () {
  'use strict';
  document.querySelectorAll('[data-icon]').forEach(function (el) {
    var parts = el.getAttribute('data-icon').split(':');
    el.innerHTML = parts[0] === 'block' ? Icons.get(parts[1]) : Icons.ui(parts[1]);
  });
  document.querySelectorAll('[data-icon-btn]').forEach(function (el) {
    el.innerHTML = Icons.ui(el.getAttribute('data-icon-btn').split(':')[1]);
  });
})();
