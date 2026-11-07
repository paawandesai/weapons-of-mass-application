/* global document, location */
// Behaviour shared by the synthesized form fixtures. Not vendor code.
(function () {
  var CAPTCHA_ANSWER = '7K3Q';
  var params = new URLSearchParams(location.search);

  // Variant blocks (?captcha, ?unmapped) exist in the DOM only when requested.
  Array.prototype.forEach.call(document.querySelectorAll('[data-variant]'), function (el) {
    if (!params.has(el.getAttribute('data-variant'))) el.remove();
  });

  var widget = document.getElementById('captcha-widget');
  var passed = false;
  if (widget) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="56"><rect width="160" height="56" fill="#eee"/>' +
      '<text x="20" y="38" font-size="30" font-family="monospace" fill="#223">' +
      CAPTCHA_ANSWER +
      '</text></svg>';
    widget.querySelector('img').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    widget.querySelector('[data-captcha-verify]').addEventListener('click', function () {
      var input = widget.querySelector('input');
      if (input.value.trim().toUpperCase() === CAPTCHA_ANSWER) {
        passed = true;
        widget.remove();
        widget = null;
      } else {
        widget.querySelector('.captcha-error').hidden = false;
        input.value = '';
      }
    });
  }

  // Forms marked data-confirm navigate to that page once native validation and the gate pass.
  var form = document.querySelector('form[data-confirm]');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (widget && !passed) {
        widget.hidden = false;
        return;
      }
      location.href = form.getAttribute('data-confirm');
    });
  }
})();
