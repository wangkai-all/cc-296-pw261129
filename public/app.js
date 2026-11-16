'use strict';
/**
 * 渐进增强：
 *  - 危险操作二次确认（服务端仍会独立校验，不依赖此脚本）。
 *  - 警告项必须逐项勾选才启用“批准”。
 *  - 域勾选与“承继”下拉互斥（同域只能二选一）。
 *  - 倒计时提示：批准有效期在页面停留期间可能耗尽。
 */
(function () {
  function confirmForms() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
      });
    });
  }

  function initReviewForm() {
    var form = document.getElementById('review-form');
    if (!form) return;
    var approve = form.querySelector('button[name="mode"][value="approve"]');
    var warnBoxes = Array.prototype.slice.call(form.querySelectorAll('input[name="warningAck"]'));
    var list = form.querySelector('input[name="domains"]');

    function syncApprove() {
      if (!approve) return;
      var warningsOk = warnBoxes.every(function (b) { return b.checked; });
      var hasDomain = form.querySelectorAll('input[name="domains"]:checked').length > 0
        || Array.prototype.some.call(
          form.querySelectorAll('select[data-carry-domain]'),
          function (s) { return Boolean(s.value); },
        );
      var blocking = form.getAttribute('data-blocking') === '1';
      approve.disabled = blocking || !warningsOk || !hasDomain;
    }

    // 域勾选与承继下拉互斥
    form.querySelectorAll('select[data-carry-domain]').forEach(function (select) {
      var domain = select.getAttribute('data-carry-domain');
      var box = form.querySelector('input[name="domains"][value="' + cssEscape(domain) + '"]');
      select.addEventListener('change', function () {
        if (box) {
          if (select.value) { box.checked = false; box.disabled = true; }
          else { box.disabled = false; }
        }
        syncApprove();
      });
      if (box) {
        box.addEventListener('change', function () {
          if (box.checked) select.value = '';
        });
      }
    });
    warnBoxes.forEach(function (b) { b.addEventListener('change', syncApprove); });
    syncApprove();
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function expiryCountdown() {
    var nodes = document.querySelectorAll('[data-expires-at]');
    if (!nodes.length) return;
    function tick() {
      nodes.forEach(function (node) {
        var at = Number(node.getAttribute('data-expires-at'));
        var diff = at - Date.now();
        var target = node.querySelector('.countdown');
        if (!target) return;
        if (diff <= 0) { target.textContent = '已过期'; target.classList.add('bad'); return; }
        var m = Math.floor(diff / 60000);
        var h = Math.floor(m / 60);
        target.textContent = h > 24 ? Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时' : (h ? h + ' 小时 ' + (m % 60) + ' 分' : m + ' 分');
      });
    }
    tick();
    window.setInterval(tick, 30000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    confirmForms();
    initReviewForm();
    expiryCountdown();
  });
})();
